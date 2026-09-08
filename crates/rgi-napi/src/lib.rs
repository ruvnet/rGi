use napi_derive::napi;

#[napi(js_name = "evaluateJson")]
pub fn evaluate_json(input: String) -> napi::Result<String> {
    rgi_core::evaluate_json(&input).map_err(napi::Error::from_reason)
}
