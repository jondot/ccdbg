use std::path::PathBuf;

#[test]
fn export_bundle_round_trips_through_json() {
    let fx = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/minimal_session.jsonl");
    let recs = ccdbg::ingest::parse_jsonl(&fx).unwrap();
    let (a, u) = ccdbg::ingest::group_messages(recs);
    let p = ccdbg::pricing::Pricing::load().unwrap();
    let sessions = ccdbg::ingest::build_sessions(a, u, &p);
    let insights = ccdbg::analyses::run_all(&sessions, &p);

    let tmp = tempfile::NamedTempFile::new().unwrap();
    ccdbg::export::write_json(tmp.path(), &sessions, &insights, &p).unwrap();

    let raw = std::fs::read_to_string(tmp.path()).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(v.get("sessions").is_some());
    assert!(v.get("insights").is_some());
    assert_eq!(v["schema_version"], 1);
}
