//! Local microbenchmark only: no model, agent, network, or human comparison.
use std::{hint::black_box, time::Instant};

fn main() {
    let input = r#"{"capability":"world.observe","allowedCapabilities":["world.observe"],"spentMicros":20,"reservedMicros":30,"requestedMicros":50,"budgetMicros":100,"confidence":0.9,"minConfidence":0.8,"stopped":false}"#;
    let iterations = 100_000u32;
    for _ in 0..1000 {
        black_box(rgi_core::evaluate_json(black_box(input)).unwrap());
    }
    let start = Instant::now();
    for _ in 0..iterations {
        black_box(rgi_core::evaluate_json(black_box(input)).unwrap());
    }
    let nanos = start.elapsed().as_nanos();
    println!("{{\"benchmark\":\"rust_policy_json\",\"iterations\":{iterations},\"totalNanos\":{nanos},\"meanNanos\":{}}}", nanos / iterations as u128);
}
