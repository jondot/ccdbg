use anyhow::{Context, Result};
use ccdbg::{analyses, export, ingest, model, pricing, web};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "ccdbg",
    version,
    about = "Local analyzer for Claude Code sessions"
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,

    /// Force full re-scan
    #[arg(long, global = true)]
    reindex: bool,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run ingest + analyses, print summary, exit
    Index,
    /// Write full analyzed JSON bundle to a path
    Export { path: String },
    /// Launch web UI (default)
    Web {
        #[arg(long, default_value_t = 6677)]
        port: u16,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd.unwrap_or(Cmd::Web { port: 6677 }) {
        Cmd::Index => {
            let claude_home = ingest::resolve_claude_home();
            eprintln!("ingesting from {}", claude_home.display());
            let pricing = pricing::Pricing::load().context("loading pricing")?;
            let cache =
                ingest::Cache::new(ingest::Cache::resolve()).context("preparing cache dir")?;
            let (sessions, n_reingested) =
                ingest::scan_incremental(&claude_home, &cache, &pricing, cli.reindex)?;
            eprintln!(
                "{} sessions total, {} files reingested",
                sessions.len(),
                n_reingested
            );

            let insights = analyses::run_all(&sessions, &pricing);
            println!();
            for i in &insights {
                let tag = match i.severity {
                    model::Severity::High => "HIGH",
                    model::Severity::Warn => "WARN",
                    model::Severity::Info => "INFO",
                };
                println!("[{tag}] {}", i.headline);
                if let Some(m) = &i.mitigation {
                    println!("       → {}", m.advice);
                }
            }
        }
        Cmd::Export { path } => {
            let claude_home = ingest::resolve_claude_home();
            let pricing = pricing::Pricing::load().context("loading pricing")?;
            let cache =
                ingest::Cache::new(ingest::Cache::resolve()).context("preparing cache dir")?;
            let (sessions, _) =
                ingest::scan_incremental(&claude_home, &cache, &pricing, cli.reindex)?;
            let insights = analyses::run_all(&sessions, &pricing);
            export::write_json(&path, &sessions, &insights, &pricing)?;
            eprintln!(
                "wrote {} sessions + {} insights to {}",
                sessions.len(),
                insights.len(),
                path
            );
        }
        Cmd::Web { port } => {
            let rt = tokio::runtime::Runtime::new().context("creating tokio runtime")?;
            rt.block_on(web::run(port, cli.reindex))?;
        }
    }
    Ok(())
}
