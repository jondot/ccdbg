//! Local HTTP server that serves the embedded web bundle and a minimal JSON
//! API. Binds 127.0.0.1 only — no external network exposure.

use crate::{analyses, export, ingest, pricing};
use anyhow::{Context, Result};
use axum::{
    extract::State,
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use include_dir::{include_dir, Dir};
use std::sync::Arc;

static WEB_DIST: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web/dist");

struct AppState {
    bundle_json: String,
}

pub async fn run(port: u16, reindex: bool) -> Result<()> {
    let claude_home = ingest::resolve_claude_home();
    eprintln!("ingesting from {}", claude_home.display());
    let pricing = pricing::Pricing::load().context("loading pricing")?;
    let cache = ingest::Cache::new(ingest::Cache::resolve()).context("preparing cache dir")?;
    let (sessions, n_reingested) =
        ingest::scan_incremental(&claude_home, &cache, &pricing, reindex)?;
    eprintln!(
        "{} sessions total, {} files reingested",
        sessions.len(),
        n_reingested
    );
    let insights = analyses::run_all(&sessions, &pricing);
    let bundle = export::build(&sessions, &insights, &pricing);
    let bundle_json = serde_json::to_string(&bundle).context("serializing bundle")?;

    let state = Arc::new(AppState { bundle_json });
    let app = Router::new()
        .route("/api/bundle", get(get_bundle))
        .route("/api/health", get(|| async { "ok" }))
        .fallback(serve_static)
        .with_state(state);

    let addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("binding {addr}"))?;

    let url = format!("http://{addr}");
    println!();
    println!("  ccdbg web");
    println!("  {url}");
    println!("  Ctrl-C to stop");
    println!();
    let _ = webbrowser::open(&url);

    axum::serve(listener, app).await.context("serving")?;
    Ok(())
}

async fn get_bundle(State(s): State<Arc<AppState>>) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/json")],
        s.bundle_json.clone(),
    )
}

async fn serve_static(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match WEB_DIST.get_file(path) {
        Some(f) => {
            let mime = mime_for(path);
            ([(header::CONTENT_TYPE, mime)], f.contents().to_vec()).into_response()
        }
        None => {
            // SPA fallback: return index.html for any unknown path
            match WEB_DIST.get_file("index.html") {
                Some(f) => (
                    [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                    f.contents().to_vec(),
                )
                    .into_response(),
                None => (StatusCode::NOT_FOUND, "not found").into_response(),
            }
        }
    }
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" => "application/json",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}
