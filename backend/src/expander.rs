use crate::models::{GraphEvent, GraphSnapshot, KnowledgeGraph, PaperNode};
use crate::providers::PaperProvider;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio::time::{sleep, Duration};
use tracing::info;

#[derive(Debug, Clone)]
pub enum ControlCommand {
    Pause,
    Resume,
    StepLevel,
    Stop,
    ExpandNode {
        node_id: String,
        top_k_in: usize,
        top_k_out: usize,
    },
}

pub struct ExpansionSession {
    pub id: String,
    pub graph: Arc<RwLock<KnowledgeGraph>>,
    pub event_tx: broadcast::Sender<GraphEvent>,
    pub control_tx: mpsc::Sender<ControlCommand>,
}

#[derive(Clone)]
pub struct SessionManager {
    pub sessions: Arc<DashMap<String, Arc<ExpansionSession>>>,
    pub provider: PaperProvider,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            provider: PaperProvider::new(),
        }
    }

    pub async fn start_session(
        &self,
        query: String,
        max_levels: u32,
        top_k_in: usize,
        top_k_out: usize,
        auto_run: bool,
    ) -> Arc<ExpansionSession> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let seed_node = self.provider.resolve_seed_paper(&query).await;
        let mut initial_graph = KnowledgeGraph::new(seed_node, max_levels);
        initial_graph.status = if auto_run {
            "running".to_string()
        } else {
            "paused".to_string()
        };

        let graph = Arc::new(RwLock::new(initial_graph));
        let (event_tx, _) = broadcast::channel(256);
        let (control_tx, control_rx) = mpsc::channel(64);

        let session = Arc::new(ExpansionSession {
            id: session_id.clone(),
            graph: graph.clone(),
            event_tx: event_tx.clone(),
            control_tx,
        });

        self.sessions.insert(session_id.clone(), session.clone());

        let provider = self.provider.clone();
        tokio::spawn(async move {
            Self::run_expansion_loop(
                session_id,
                graph,
                provider,
                event_tx,
                control_rx,
                max_levels,
                top_k_in,
                top_k_out,
                auto_run,
            )
            .await;
        });

        session
    }

    pub async fn get_snapshot(&self, session_id: &str) -> Option<GraphSnapshot> {
        let session = self.sessions.get(session_id)?;
        let g = session.graph.read().await;
        Some(g.to_snapshot())
    }

    async fn run_expansion_loop(
        session_id: String,
        graph: Arc<RwLock<KnowledgeGraph>>,
        provider: PaperProvider,
        event_tx: broadcast::Sender<GraphEvent>,
        mut control_rx: mpsc::Receiver<ControlCommand>,
        max_levels: u32,
        top_k_in: usize,
        top_k_out: usize,
        auto_run: bool,
    ) {
        let mut is_paused = !auto_run;
        let mut step_allowance: u32 = 0;

        // Give SSE subscriber a brief moment to connect so they see live level growth
        sleep(Duration::from_millis(250)).await;

        let mut current_level: u32 = 0;

        loop {
            // Drain any pending control commands first
            while let Ok(cmd) = control_rx.try_recv() {
                if Self::handle_control_cmd(
                    cmd,
                    &mut is_paused,
                    &mut step_allowance,
                    &graph,
                    &provider,
                    &event_tx,
                )
                .await
                {
                    return; // Stop requested
                }
            }

            // If paused and no step allowance or finished all automatic levels, wait for commands
            if is_paused && step_allowance == 0 || current_level >= max_levels {
                if current_level >= max_levels {
                    let mut g = graph.write().await;
                    if g.status != "completed" {
                        g.status = "completed".to_string();
                        let _ = event_tx.send(GraphEvent::StatusChanged {
                            status: "completed".to_string(),
                            message: format!(
                                "Reached configured level depth ({} levels). Click '+1 Level' or any node to keep growing!",
                                max_levels
                            ),
                        });
                    }
                }

                match control_rx.recv().await {
                    Some(cmd) => {
                        if Self::handle_control_cmd(
                            cmd,
                            &mut is_paused,
                            &mut step_allowance,
                            &graph,
                            &provider,
                            &event_tx,
                        )
                        .await
                        {
                            return;
                        }
                        // If a step was requested even when current_level >= max_levels, allow expanding next level
                        if step_allowance > 0 && current_level >= max_levels {
                            // Continue below to expand the next frontier
                        } else if current_level >= max_levels && is_paused {
                            continue;
                        }
                    }
                    None => return,
                }
            }

            // Find unexpanded frontier nodes at `current_level`
            let frontier: Vec<PaperNode> = {
                let g = graph.read().await;
                let mut candidates: Vec<PaperNode> = g
                    .nodes
                    .values()
                    .filter(|n| !n.expanded && n.bfs_level == current_level)
                    .cloned()
                    .collect();
                // Prioritize highest global citation impact first so the most influential math papers expand first
                candidates.sort_by(|a, b| b.global_citations_count.cmp(&a.global_citations_count));
                // Cap frontier per automatic level to 6 nodes so level-by-level streaming stays responsive
                if current_level > 0 {
                    candidates.truncate(6);
                }
                candidates
            };

            if frontier.is_empty() {
                current_level += 1;
                if step_allowance > 0 {
                    step_allowance -= 1;
                }
                continue;
            }

            let next_level = current_level + 1;
            let frontier_ids: Vec<String> = frontier.iter().map(|n| n.id.clone()).collect();
            let _ = event_tx.send(GraphEvent::LevelStarted {
                level: next_level,
                frontier_ids,
            });

            info!(
                "Session {}: Expanding Level {} -> {} ({} frontier nodes)",
                session_id,
                current_level,
                next_level,
                frontier.len()
            );

            for center_node in frontier {
                // Check if user paused/stopped mid-level
                while let Ok(cmd) = control_rx.try_recv() {
                    if Self::handle_control_cmd(
                        cmd,
                        &mut is_paused,
                        &mut step_allowance,
                        &graph,
                        &provider,
                        &event_tx,
                    )
                    .await
                    {
                        return;
                    }
                }

                while is_paused && step_allowance == 0 {
                    match control_rx.recv().await {
                        Some(cmd) => {
                            if Self::handle_control_cmd(
                                cmd,
                                &mut is_paused,
                                &mut step_allowance,
                                &graph,
                                &provider,
                                &event_tx,
                            )
                            .await
                            {
                                return;
                            }
                        }
                        None => return,
                    }
                }

                Self::expand_single_node(
                    &center_node,
                    next_level,
                    top_k_in,
                    top_k_out,
                    &graph,
                    &provider,
                    &event_tx,
                )
                .await;

                // Pacing delay so the user sees smooth level-by-level organic growth in the UI
                sleep(Duration::from_millis(350)).await;
            }

            let (total_nodes, total_edges) = {
                let mut g = graph.write().await;
                g.current_level = next_level;
                (g.nodes.len(), g.edges.len())
            };

            let _ = event_tx.send(GraphEvent::LevelCompleted {
                level: next_level,
                total_nodes,
                total_edges,
            });

            current_level = next_level;
            if step_allowance > 0 {
                step_allowance -= 1;
                if step_allowance == 0 && is_paused {
                    let mut g = graph.write().await;
                    g.status = "paused".to_string();
                    let _ = event_tx.send(GraphEvent::StatusChanged {
                        status: "paused".to_string(),
                        message: format!("Completed Level {} step.", current_level),
                    });
                }
            }
        }
    }

    async fn handle_control_cmd(
        cmd: ControlCommand,
        is_paused: &mut bool,
        step_allowance: &mut u32,
        graph: &Arc<RwLock<KnowledgeGraph>>,
        provider: &PaperProvider,
        event_tx: &broadcast::Sender<GraphEvent>,
    ) -> bool {
        match cmd {
            ControlCommand::Pause => {
                *is_paused = true;
                *step_allowance = 0;
                let mut g = graph.write().await;
                g.status = "paused".to_string();
                let _ = event_tx.send(GraphEvent::StatusChanged {
                    status: "paused".to_string(),
                    message: "Expansion paused by user.".to_string(),
                });
                false
            }
            ControlCommand::Resume => {
                *is_paused = false;
                let mut g = graph.write().await;
                g.status = "running".to_string();
                let _ = event_tx.send(GraphEvent::StatusChanged {
                    status: "running".to_string(),
                    message: "Resumed online level-by-level expansion.".to_string(),
                });
                false
            }
            ControlCommand::StepLevel => {
                *is_paused = true;
                *step_allowance += 1;
                let mut g = graph.write().await;
                if g.current_level >= g.max_levels {
                    g.max_levels = g.current_level + 1;
                }
                g.status = "stepping".to_string();
                let _ = event_tx.send(GraphEvent::StatusChanged {
                    status: "running".to_string(),
                    message: "Stepping +1 level in parallel...".to_string(),
                });
                false
            }
            ControlCommand::Stop => {
                let mut g = graph.write().await;
                g.status = "stopped".to_string();
                let _ = event_tx.send(GraphEvent::StatusChanged {
                    status: "stopped".to_string(),
                    message: "Expansion stopped.".to_string(),
                });
                true
            }
            ControlCommand::ExpandNode {
                node_id,
                top_k_in,
                top_k_out,
            } => {
                let target_node = {
                    let g = graph.read().await;
                    g.nodes.get(&node_id).cloned()
                };
                if let Some(node) = target_node {
                    let next_level = node.bfs_level + 1;
                    Self::expand_single_node(
                        &node, next_level, top_k_in, top_k_out, graph, provider, event_tx,
                    )
                    .await;
                }
                false
            }
        }
    }

    async fn expand_single_node(
        center_node: &PaperNode,
        next_level: u32,
        top_k_in: usize,
        top_k_out: usize,
        graph: &Arc<RwLock<KnowledgeGraph>>,
        provider: &PaperProvider,
        event_tx: &broadcast::Sender<GraphEvent>,
    ) {
        let _ = event_tx.send(GraphEvent::NodeExpanding {
            node_id: center_node.id.clone(),
            title: center_node.title.clone(),
            level: next_level,
        });

        // Fetch in-nodes (references u -> center) and out-nodes (citations center -> w) in parallel!
        let (in_nodes, out_nodes) = provider
            .fetch_neighbors_parallel(center_node, next_level, top_k_in, top_k_out)
            .await;

        let mut new_nodes = Vec::new();
        let mut new_edges = Vec::new();

        let updated_metrics = {
            let mut g = graph.write().await;
            if let Some(c) = g.nodes.get_mut(&center_node.id) {
                c.expanded = true;
            }

            // Insert In-Nodes (u -> center_node)
            for in_node in in_nodes {
                let in_id = in_node.id.clone();
                let (is_new, stored) = g.upsert_node(in_node);
                if is_new {
                    new_nodes.push(stored);
                }
                if let Some(edge) = g.add_edge(&in_id, &center_node.id, next_level) {
                    new_edges.push(edge);
                }
            }

            // Insert Out-Nodes (center_node -> w)
            for out_node in out_nodes {
                let out_id = out_node.id.clone();
                let (is_new, stored) = g.upsert_node(out_node);
                if is_new {
                    new_nodes.push(stored);
                }
                if let Some(edge) = g.add_edge(&center_node.id, &out_id, next_level) {
                    new_edges.push(edge);
                }
            }

            g.recompute_all_metrics()
        };

        // Ensure `new_nodes` reflect their freshly computed degrees and creativity scores
        for node in &mut new_nodes {
            if let Some(m) = updated_metrics.iter().find(|u| u.id == node.id) {
                node.in_degree = m.in_degree;
                node.out_degree = m.out_degree;
                node.global_references_count = m.global_references_count;
                node.global_citations_count = m.global_citations_count;
                node.creativity_score = m.creativity_score;
                node.smoothed_creativity_score = m.smoothed_creativity_score;
                node.global_creativity_score = m.global_creativity_score;
            }
        }

        let _ = event_tx.send(GraphEvent::NodeExpanded {
            center_id: center_node.id.clone(),
            level: next_level,
            new_nodes,
            new_edges,
            updated_metrics,
        });
    }
}
