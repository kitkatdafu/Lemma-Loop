use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Represents a mathematical paper node in the citation knowledge graph.
///
/// Directed Edge Convention:
/// An edge `u -> v` means paper `u` is referenced by paper `v` (i.e., `u` influenced `v`).
/// - `in_degree`: Number of references in the graph (`u -> this`).
/// - `out_degree`: Number of citing papers in the graph (`this -> w`).
/// - `creativity_score`: `out_degree / in_degree` (with fallback when `in_degree == 0`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaperNode {
    pub id: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<u32>,
    pub venue: Option<String>,
    pub doi_url: Option<String>,
    pub pdf_url: Option<String>,
    pub google_scholar_url: String,
    pub google_scholar_cited_by_url: String,
    pub openalex_id: Option<String>,
    pub abstract_snippet: Option<String>,
    /// Signed level relative to seed (e.g. -1 for reference of seed, +1 for paper citing seed, 0 for seed)
    pub signed_level: i32,
    /// BFS distance (0, 1, 2, ...) from the seed node
    pub bfs_level: u32,
    /// Number of incoming edges `u -> this` currently in the active subgraph
    pub in_degree: usize,
    /// Number of outgoing edges `this -> w` currently in the active subgraph
    pub out_degree: usize,
    /// Total known references in the paper's bibliography
    pub global_references_count: usize,
    /// Total known citations across mathematical literature
    pub global_citations_count: usize,
    /// Actual creativity ratio using real total citations (`out_degree`) and real total references (`in_degree`):
    /// `max(global_citations_count, out_degree) / max(global_references_count, in_degree)`
    pub creativity_score: f64,
    /// Smoothed actual creativity ratio: `(actual_out + 1) / (actual_in + 1)`
    pub smoothed_creativity_score: f64,
    /// Subgraph-only creativity ratio (visible edges in UI only): `out_degree / in_degree`
    pub global_creativity_score: f64,
    /// Whether this node's in/out neighborhood has been expanded
    pub expanded: bool,
}

impl PaperNode {
    /// Returns the actual out-degree (total citations count, at least the visible subgraph `out_degree`).
    pub fn actual_out_degree(&self) -> usize {
        self.global_citations_count.max(self.out_degree)
    }

    /// Returns the actual in-degree (total references count in bibliography, at least the visible subgraph `in_degree`).
    pub fn actual_in_degree(&self) -> usize {
        self.global_references_count.max(self.in_degree)
    }

    /// Recomputes all creativity metrics using the actual citation (`out_degree`)
    /// and reference (`in_degree`) counts.
    pub fn recompute_creativity(&mut self) {
        let actual_out = self.actual_out_degree();
        let actual_in = self.actual_in_degree();
        self.global_citations_count = actual_out;
        self.global_references_count = actual_in;

        // Primary creativity score uses actual citation & reference counts (e.g. 980 / 20 = 49.0 for Zhang 2014)
        self.creativity_score = compute_creativity_ratio(actual_out, actual_in);
        self.smoothed_creativity_score =
            ((actual_out as f64 + 1.0) / (actual_in as f64 + 1.0) * 100.0).round() / 100.0;
        // Keep subgraph ratio available for comparison
        self.global_creativity_score = compute_creativity_ratio(self.out_degree, self.in_degree);
    }
}

/// Computes `out_degree / in_degree` cleanly.
/// When `in_degree == 0`, uses `max(1, in_degree)` so nodes with outgoing citations
/// still have a finite, meaningful numeric score equal to `out_degree as f64`.
pub fn compute_creativity_ratio(out_degree: usize, in_degree: usize) -> f64 {
    if in_degree == 0 {
        out_degree as f64
    } else {
        let ratio = out_degree as f64 / in_degree as f64;
        (ratio * 100.0).round() / 100.0
    }
}

/// Builds a direct Google Scholar search URL for a given paper title and first author.
pub fn build_google_scholar_url(title: &str, authors: &[String]) -> String {
    let query = if let Some(first) = authors.first() {
        format!("\"{}\" {}", title, first)
    } else {
        format!("\"{}\"", title)
    };
    format!(
        "https://scholar.google.com/scholar?q={}",
        urlencoding::encode(&query)
    )
}

/// Builds a Google Scholar query URL focused on papers citing the given work.
pub fn build_google_scholar_cited_by_url(title: &str) -> String {
    let query = format!("\"{}\"", title);
    format!(
        "https://scholar.google.com/scholar?q={}&hl=en&as_sdt=0,5",
        urlencoding::encode(&query)
    )
}

/// Directed edge `source -> target` where `source` is referenced by `target`
/// (`source` contributed to / influenced `target`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct CitationEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub level_discovered: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeMetricsUpdate {
    pub id: String,
    pub in_degree: usize,
    pub out_degree: usize,
    pub global_references_count: usize,
    pub global_citations_count: usize,
    pub creativity_score: f64,
    pub smoothed_creativity_score: f64,
    pub global_creativity_score: f64,
    pub expanded: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphSnapshot {
    pub seed_id: String,
    pub nodes: Vec<PaperNode>,
    pub edges: Vec<CitationEdge>,
    pub current_level: u32,
    pub max_levels: u32,
    pub status: String,
}

/// Events streamed to the React frontend via Server-Sent Events (SSE)
/// during online level-by-level expansion.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GraphEvent {
    SessionInitialized {
        session_id: String,
        snapshot: GraphSnapshot,
    },
    LevelStarted {
        level: u32,
        frontier_ids: Vec<String>,
    },
    NodeExpanding {
        node_id: String,
        title: String,
        level: u32,
    },
    NodeExpanded {
        center_id: String,
        level: u32,
        new_nodes: Vec<PaperNode>,
        new_edges: Vec<CitationEdge>,
        updated_metrics: Vec<NodeMetricsUpdate>,
    },
    LevelCompleted {
        level: u32,
        total_nodes: usize,
        total_edges: usize,
    },
    StatusChanged {
        status: String,
        message: String,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartSessionRequest {
    pub query: String,
    #[serde(default = "default_max_levels")]
    pub max_levels: u32,
    #[serde(default = "default_top_k_in")]
    pub top_k_in: usize,
    #[serde(default = "default_top_k_out")]
    pub top_k_out: usize,
    #[serde(default = "default_auto_run")]
    pub auto_run: bool,
}

fn default_max_levels() -> u32 {
    1
}
fn default_top_k_in() -> usize {
    12
}
fn default_top_k_out() -> usize {
    12
}
fn default_auto_run() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlSessionRequest {
    /// "pause" | "resume" | "step" | "stop"
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExpandNodeRequest {
    pub node_id: String,
    #[serde(default = "default_top_k_in")]
    pub top_k_in: usize,
    #[serde(default = "default_top_k_out")]
    pub top_k_out: usize,
}

/// Maintain an in-memory directed graph with fast degree & creativity recalculation.
#[derive(Debug, Clone, Default)]
pub struct KnowledgeGraph {
    pub seed_id: String,
    pub nodes: HashMap<String, PaperNode>,
    pub edges: HashMap<String, CitationEdge>,
    pub current_level: u32,
    pub max_levels: u32,
    pub status: String,
}

impl KnowledgeGraph {
    pub fn new(seed_node: PaperNode, max_levels: u32) -> Self {
        let seed_id = seed_node.id.clone();
        let mut nodes = HashMap::new();
        nodes.insert(seed_id.clone(), seed_node);
        Self {
            seed_id,
            nodes,
            edges: HashMap::new(),
            current_level: 0,
            max_levels,
            status: "running".to_string(),
        }
    }

    /// Inserts or merges a node and returns `true` if it was newly added.
    pub fn upsert_node(&mut self, mut node: PaperNode) -> (bool, PaperNode) {
        if let Some(existing) = self.nodes.get_mut(&node.id) {
            if existing.global_citations_count == 0 && node.global_citations_count > 0 {
                existing.global_citations_count = node.global_citations_count;
            }
            if existing.global_references_count == 0 && node.global_references_count > 0 {
                existing.global_references_count = node.global_references_count;
            }
            if existing.doi_url.is_none() && node.doi_url.is_some() {
                existing.doi_url = node.doi_url;
            }
            if existing.pdf_url.is_none() && node.pdf_url.is_some() {
                existing.pdf_url = node.pdf_url;
            }
            if existing.openalex_id.is_none() && node.openalex_id.is_some() {
                existing.openalex_id = node.openalex_id;
            }
            existing.recompute_creativity();
            (false, existing.clone())
        } else {
            node.recompute_creativity();
            let cloned = node.clone();
            self.nodes.insert(node.id.clone(), node);
            (true, cloned)
        }
    }

    /// Adds a directed edge `source -> target` (meaning `source` is referenced by `target`)
    /// and returns `Some(edge)` if it was newly added.
    pub fn add_edge(
        &mut self,
        source: &str,
        target: &str,
        level_discovered: u32,
    ) -> Option<CitationEdge> {
        if source == target {
            return None;
        }
        let edge_id = format!("{}->{}", source, target);
        if self.edges.contains_key(&edge_id) {
            return None;
        }
        let edge = CitationEdge {
            id: edge_id.clone(),
            source: source.to_string(),
            target: target.to_string(),
            level_discovered,
        };
        self.edges.insert(edge_id, edge.clone());
        Some(edge)
    }

    /// Recomputes `in_degree`, `out_degree`, and `creativity_score = out_degree / in_degree`
    /// for all nodes in the graph and returns updated metrics.
    pub fn recompute_all_metrics(&mut self) -> Vec<NodeMetricsUpdate> {
        let mut in_counts: HashMap<String, usize> = HashMap::new();
        let mut out_counts: HashMap<String, usize> = HashMap::new();

        for edge in self.edges.values() {
            *out_counts.entry(edge.source.clone()).or_insert(0) += 1;
            *in_counts.entry(edge.target.clone()).or_insert(0) += 1;
        }

        let mut updates = Vec::with_capacity(self.nodes.len());
        for (id, node) in self.nodes.iter_mut() {
            node.in_degree = *in_counts.get(id).unwrap_or(&0);
            node.out_degree = *out_counts.get(id).unwrap_or(&0);
            node.recompute_creativity();
            updates.push(NodeMetricsUpdate {
                id: id.clone(),
                in_degree: node.in_degree,
                out_degree: node.out_degree,
                global_references_count: node.global_references_count,
                global_citations_count: node.global_citations_count,
                creativity_score: node.creativity_score,
                smoothed_creativity_score: node.smoothed_creativity_score,
                global_creativity_score: node.global_creativity_score,
                expanded: node.expanded,
            });
        }
        updates
    }

    pub fn to_snapshot(&self) -> GraphSnapshot {
        let mut nodes: Vec<PaperNode> = self.nodes.values().cloned().collect();
        nodes.sort_by(|a, b| {
            a.bfs_level
                .cmp(&b.bfs_level)
                .then_with(|| b.creativity_score.partial_cmp(&a.creativity_score).unwrap_or(std::cmp::Ordering::Equal))
        });
        let mut edges: Vec<CitationEdge> = self.edges.values().cloned().collect();
        edges.sort_by(|a, b| a.id.cmp(&b.id));

        GraphSnapshot {
            seed_id: self.seed_id.clone(),
            nodes,
            edges,
            current_level: self.current_level,
            max_levels: self.max_levels,
            status: self.status.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_creativity_calculation() {
        assert_eq!(compute_creativity_ratio(20, 10), 2.0);
        assert_eq!(compute_creativity_ratio(15, 0), 15.0);
        assert_eq!(compute_creativity_ratio(0, 10), 0.0);
        assert_eq!(compute_creativity_ratio(7, 4), 1.75);
    }

    #[test]
    fn test_graph_degrees_and_creativity() {
        let seed = PaperNode {
            id: "zhang-2014".to_string(),
            title: "Bounded gaps between primes".to_string(),
            authors: vec!["Yitang Zhang".to_string()],
            year: Some(2014),
            venue: Some("Annals of Mathematics".to_string()),
            doi_url: None,
            pdf_url: None,
            google_scholar_url: String::new(),
            google_scholar_cited_by_url: String::new(),
            openalex_id: None,
            abstract_snippet: None,
            signed_level: 0,
            bfs_level: 0,
            in_degree: 0,
            out_degree: 0,
            global_references_count: 20,
            global_citations_count: 950,
            creativity_score: 0.0,
            smoothed_creativity_score: 1.0,
            global_creativity_score: 47.5,
            expanded: true,
        };

        let mut graph = KnowledgeGraph::new(seed, 2);

        // Add 2 in-nodes (references) and 4 out-nodes (citing papers)
        for i in 1..=2 {
            let mut n = graph.nodes.get("zhang-2014").unwrap().clone();
            n.id = format!("ref-{}", i);
            graph.upsert_node(n);
            graph.add_edge(&format!("ref-{}", i), "zhang-2014", 1);
        }
        for i in 1..=4 {
            let mut n = graph.nodes.get("zhang-2014").unwrap().clone();
            n.id = format!("cite-{}", i);
            graph.upsert_node(n);
            graph.add_edge("zhang-2014", &format!("cite-{}", i), 1);
        }

        graph.recompute_all_metrics();
        let zhang = graph.nodes.get("zhang-2014").unwrap();
        assert_eq!(zhang.in_degree, 2);
        assert_eq!(zhang.out_degree, 4);
        assert_eq!(zhang.global_references_count, 20);
        assert_eq!(zhang.global_citations_count, 950);
        assert_eq!(zhang.creativity_score, 47.5);
    }
}
