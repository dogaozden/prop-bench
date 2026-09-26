//! Contestant-facing proof validator. This target exposes only proof replay.
//! Build the distributed runtime with `--no-default-features`.

use clap::{Parser, Subcommand};
use propbench::validate::cmd_validate;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "propbench-validate", about = "Validate propositional logic proofs")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Validate a proof against a theorem
    Validate {
        /// Path to theorem JSON file (single theorem object)
        #[arg(long)]
        theorem: PathBuf,

        /// Path to proof JSON file (array of proof lines)
        #[arg(long)]
        proof: PathBuf,

        /// Require submitted depth and CP/IP ranges to match engine-derived scope
        #[arg(long)]
        strict_protocol: bool,
    },
}

fn main() {
    let Cli { command: Commands::Validate { theorem, proof, strict_protocol } } = Cli::parse();
    if let Err(error) = cmd_validate(&theorem, &proof, strict_protocol) {
        eprintln!("Error: {}", error);
        std::process::exit(1);
    }
}
