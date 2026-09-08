#![forbid(unsafe_code)]
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn evaluate_json(input: &str) -> Result<String, JsValue> {
    rgi_core::evaluate_json(input).map_err(|message| JsValue::from_str(&message))
}
