//! Pure policy evaluation. No network, filesystem, clocks, or agent execution.
#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

pub const MAX_INPUT_BYTES: usize = 65_536;
pub const MAX_CAPABILITIES: usize = 256;
pub const MAX_IDENTIFIER_BYTES: usize = 128;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PolicyInput {
    pub capability: String,
    pub allowed_capabilities: Vec<String>,
    pub spent_micros: u64,
    pub reserved_micros: u64,
    pub requested_micros: u64,
    pub budget_micros: u64,
    pub confidence: f64,
    pub min_confidence: f64,
    pub stopped: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PolicyDecision {
    pub allowed: bool,
    pub reason: &'static str,
}

fn decision(reason: &'static str) -> PolicyDecision {
    PolicyDecision {
        allowed: reason == "allowed",
        reason,
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'/' | b'-'))
}

/// Evaluate an explicitly supplied snapshot. The caller must atomically reserve
/// funds before execution; this pure function does not provide synchronization.
pub fn evaluate(input: &PolicyInput) -> PolicyDecision {
    if input.stopped {
        return decision("stopped");
    }
    if !valid_identifier(&input.capability)
        || input.allowed_capabilities.len() > MAX_CAPABILITIES
        || input
            .allowed_capabilities
            .iter()
            .any(|s| !valid_identifier(s))
        || !input.allowed_capabilities.contains(&input.capability)
    {
        return decision("capability_denied");
    }
    if !input.confidence.is_finite()
        || !input.min_confidence.is_finite()
        || !(0.0..=1.0).contains(&input.confidence)
        || !(0.0..=1.0).contains(&input.min_confidence)
        || input.confidence < input.min_confidence
    {
        return decision("invalid_confidence");
    }
    match input
        .spent_micros
        .checked_add(input.reserved_micros)
        .and_then(|sum| sum.checked_add(input.requested_micros))
    {
        Some(total) if total <= input.budget_micros => decision("allowed"),
        _ => decision("budget_exhausted"),
    }
}

/// Strict camelCase JSON API shared by WASM and Node native bindings.
/// Malformed, missing, unknown, or oversized fields fail with an error.
pub fn evaluate_json(input: &str) -> Result<String, String> {
    if input.len() > MAX_INPUT_BYTES {
        return Err("policy input exceeds 65536 bytes".into());
    }
    let input: PolicyInput =
        serde_json::from_str(input).map_err(|_| "invalid policy input".to_string())?;
    serde_json::to_string(&evaluate(&input)).map_err(|_| "decision serialization failed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> PolicyInput {
        PolicyInput {
            capability: "world.observe".into(),
            allowed_capabilities: vec!["world.observe".into()],
            spent_micros: 20,
            reserved_micros: 30,
            requested_micros: 50,
            budget_micros: 100,
            confidence: 0.9,
            min_confidence: 0.8,
            stopped: false,
        }
    }
    #[test]
    fn exact_budget_allowed() {
        assert_eq!(evaluate(&input()), decision("allowed"));
    }
    #[test]
    fn default_deny() {
        let mut i = input();
        i.allowed_capabilities.clear();
        assert_eq!(evaluate(&i).reason, "capability_denied");
    }
    #[test]
    fn stop_has_precedence() {
        let mut i = input();
        i.stopped = true;
        i.confidence = f64::NAN;
        assert_eq!(evaluate(&i).reason, "stopped");
    }
    #[test]
    fn budget_exceeded() {
        let mut i = input();
        i.requested_micros += 1;
        assert_eq!(evaluate(&i).reason, "budget_exhausted");
    }
    #[test]
    fn integer_overflow_denied() {
        let mut i = input();
        i.spent_micros = u64::MAX;
        i.budget_micros = u64::MAX;
        assert_eq!(evaluate(&i).reason, "budget_exhausted");
    }
    #[test]
    fn confidence_validation() {
        for c in [f64::NAN, f64::INFINITY, -0.1, 1.1, 0.7] {
            let mut i = input();
            i.confidence = c;
            assert_eq!(evaluate(&i).reason, "invalid_confidence");
        }
        let mut i = input();
        i.min_confidence = f64::NAN;
        assert_eq!(evaluate(&i).reason, "invalid_confidence");
    }
    #[test]
    fn identifiers_bounded() {
        for name in [
            "".to_string(),
            "*".into(),
            "a".repeat(129),
            "world observe".into(),
        ] {
            let mut i = input();
            i.capability = name.clone();
            i.allowed_capabilities = vec![name];
            assert_eq!(evaluate(&i).reason, "capability_denied");
        }
    }
    #[test]
    fn list_bounded() {
        let mut i = input();
        i.allowed_capabilities = vec![i.capability.clone(); 257];
        assert_eq!(evaluate(&i).reason, "capability_denied");
    }
    #[test]
    fn strict_json() {
        for value in ["{}", "null", "[]", "{\"capability\":NaN}"] {
            assert!(evaluate_json(value).is_err());
        }
        assert!(evaluate_json(&" ".repeat(MAX_INPUT_BYTES + 1)).is_err());
    }
    #[test]
    fn json_contract() {
        let s = r#"{"capability":"world.observe","allowedCapabilities":["world.observe"],"spentMicros":20,"reservedMicros":30,"requestedMicros":50,"budgetMicros":100,"confidence":0.9,"minConfidence":0.8,"stopped":false}"#;
        assert_eq!(
            evaluate_json(s).unwrap(),
            r#"{"allowed":true,"reason":"allowed"}"#
        );
        assert!(evaluate_json(&s.replace("20", "-1")).is_err());
        assert!(evaluate_json(&s.replace("20", "1.5")).is_err());
        assert!(evaluate_json(&s.replace("20", "18446744073709551616")).is_err());
        assert!(
            evaluate_json(&s.replace("\"stopped\":false", "\"extra\":0,\"stopped\":false"))
                .is_err()
        );
        assert!(evaluate_json(
            &s.replace("\"stopped\":false", "\"stopped\":true,\"stopped\":false")
        )
        .is_err());
    }
    #[test]
    fn budget_arithmetic_matches_wide_integer_oracle() {
        let values = [0, 1, 50, u64::MAX / 2, u64::MAX - 1, u64::MAX];
        for spent in values {
            for reserved in values {
                for requested in values {
                    for budget in values {
                        let mut i = input();
                        i.spent_micros = spent;
                        i.reserved_micros = reserved;
                        i.requested_micros = requested;
                        i.budget_micros = budget;
                        let expected = (spent as u128) + (reserved as u128) + (requested as u128)
                            <= budget as u128;
                        assert_eq!(evaluate(&i).allowed, expected);
                    }
                }
            }
        }
    }
}
