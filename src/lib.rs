pub mod replay;
pub mod golf;

use logic_core::models::theorem::{DifficultySpec, Theorem};
use logic_core::services::ServeAnalysis;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct BenchTheorem {
    pub id: String,
    pub premises: Vec<String>,
    pub conclusion: String,
    pub difficulty: String,
    pub difficulty_value: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub difficulty_spec: Option<DifficultySpec>,
    /// Populated only in `--tournament` mode: the serve-filter analysis that
    /// certified this theorem as servable. Never round-tripped back in on read —
    /// `analyze` always recomputes fresh from premises/conclusion, so it's exempt
    /// from deserialization (`ServeAnalysis` only derives `Serialize`).
    #[serde(skip_serializing_if = "Option::is_none", skip_deserializing)]
    pub serve_analysis: Option<ServeAnalysis>,
}

impl From<&Theorem> for BenchTheorem {
    fn from(t: &Theorem) -> Self {
        BenchTheorem {
            id: t.id.clone(),
            premises: t.premises.iter().map(|f| f.ascii_string_bracketed()).collect(),
            conclusion: t.conclusion.ascii_string_bracketed(),
            difficulty: difficulty_label(t.difficulty_value),
            difficulty_value: t.difficulty_value,
            difficulty_spec: None,
            serve_analysis: None,
        }
    }
}

fn difficulty_label(value: u8) -> String {
    match value {
        1..=25 => "Easy".to_string(),
        26..=45 => "Medium".to_string(),
        46..=70 => "Hard".to_string(),
        71..=85 => "Expert".to_string(),
        86..=95 => "Nightmare".to_string(),
        _ => "Marathon".to_string(),
    }
}
