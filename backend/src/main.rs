pub mod expander;
pub mod models;
pub mod providers;
pub mod seed_data;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use expander::{ControlCommand, SessionManager};
use futures::stream::Stream;
use models::{
    ControlSessionRequest, ExpandNodeRequest, GraphEvent, GraphSnapshot, KnowledgeGraph,
    StartSessionRequest,
};
use seed_data::{zhang_2014_citations, zhang_2014_references, zhang_2014_seed_node};
use std::{convert::Infallible, net::SocketAddr, time::Duration};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lemmaloop_backend=info,tower_http=info".into()),
        )
        .init();

    let manager = SessionManager::new();

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(health_check))
        .route("/api/preset/zhang2014", get(get_zhang_preset))
        .route("/api/session/start", post(start_session))
        .route("/api/session/:id/snapshot", get(get_session_snapshot))
        .route("/api/session/:id/stream", get(stream_session_events))
        .route("/api/session/:id/control", post(control_session))
        .route("/api/session/:id/expand-node", post(expand_single_node))
        .layer(cors)
        .with_state(manager);

    let addr = SocketAddr::from(([0, 0, 0, 0], 3001));
    info!("LemmaLoop Rust backend listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn health_check() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "service": "lemmaloop-backend"
    }))
}

/// Returns an instant, pre-populated Level-1 snapshot of Yitang Zhang's "Bounded gaps between primes"
/// with its Annals of Mathematics (2014) references (In-Nodes) and landmark citing works (Out-Nodes),
/// with all `out_degree / in_degree` creativity scores calculated.
async fn get_zhang_preset() -> Json<GraphSnapshot> {
    let mut seed = zhang_2014_seed_node();
    seed.expanded = true;
    let mut graph = KnowledgeGraph::new(seed, 2);

    for r in zhang_2014_references() {
        let id = r.id.clone();
        graph.upsert_node(r);
        graph.add_edge(&id, "W2150462872", 1);
    }

    for c in zhang_2014_citations() {
        let id = c.id.clone();
        graph.upsert_node(c);
        graph.add_edge("W2150462872", &id, 1);
    }

    graph.current_level = 1;
    graph.status = "ready".to_string();
    graph.recompute_all_metrics();

    Json(graph.to_snapshot())
}

async fn start_session(
    State(manager): State<SessionManager>,
    Json(req): Json<StartSessionRequest>,
) -> impl IntoResponse {
    let session = manager
        .start_session(
            req.query,
            req.max_levels,
            req.top_k_in,
            req.top_k_out,
            req.auto_run,
        )
        .await;

    let snapshot = {
        let g = session.graph.read().await;
        g.to_snapshot()
    };

    Json(serde_json::json!({
        "session_id": session.id,
        "snapshot": snapshot
    }))
}

async fn get_session_snapshot(
    State(manager): State<SessionManager>,
    Path(id): Path<String>,
) -> Result<Json<GraphSnapshot>, StatusCode> {
    match manager.get_snapshot(&id).await {
        Some(snap) => Ok(Json(snap)),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn stream_session_events(
    State(manager): State<SessionManager>,
    Path(id): Path<String>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, StatusCode> {
    let session = manager
        .sessions
        .get(&id)
        .ok_or(StatusCode::NOT_FOUND)?
        .clone();

    let rx = session.event_tx.subscribe();
    let initial_snapshot = {
        let g = session.graph.read().await;
        g.to_snapshot()
    };

    let init_event = GraphEvent::SessionInitialized {
        session_id: id.clone(),
        snapshot: initial_snapshot,
    };

    let init_stream = futures::stream::once(async move {
        let json = serde_json::to_string(&init_event).unwrap_or_default();
        Ok::<Event, Infallible>(Event::default().data(json))
    });

    let updates_stream = BroadcastStream::new(rx).filter_map(|msg| match msg {
        Ok(ev) => {
            let json = serde_json::to_string(&ev).unwrap_or_default();
            Some(Ok::<Event, Infallible>(Event::default().data(json)))
        }
        Err(_) => None,
    });

    let combined = init_stream.chain(updates_stream);

    Ok(Sse::new(combined).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(10))
            .text("keep-alive"),
    ))
}

async fn control_session(
    State(manager): State<SessionManager>,
    Path(id): Path<String>,
    Json(req): Json<ControlSessionRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let session = manager
        .sessions
        .get(&id)
        .ok_or(StatusCode::NOT_FOUND)?
        .clone();

    let cmd = match req.action.as_str() {
        "pause" => ControlCommand::Pause,
        "resume" => ControlCommand::Resume,
        "step" => ControlCommand::StepLevel,
        "stop" => ControlCommand::Stop,
        _ => return Err(StatusCode::BAD_REQUEST),
    };

    let _ = session.control_tx.send(cmd).await;
    Ok(Json(serde_json::json!({ "ok": true, "action": req.action })))
}

async fn expand_single_node(
    State(manager): State<SessionManager>,
    Path(id): Path<String>,
    Json(req): Json<ExpandNodeRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let session = manager
        .sessions
        .get(&id)
        .ok_or(StatusCode::NOT_FOUND)?
        .clone();

    let _ = session
        .control_tx
        .send(ControlCommand::ExpandNode {
            node_id: req.node_id.clone(),
            top_k_in: req.top_k_in,
            top_k_out: req.top_k_out,
        })
        .await;

    Ok(Json(serde_json::json!({
        "ok": true,
        "node_id": req.node_id
    })))
}
