import React, { Suspense } from "react";
import { Routes, Route, NavLink } from "react-router-dom";
import Dashboard from "./pages/Dashboard";
import { RunnerProvider } from "./context/RunnerContext";
import { ThemeToggle } from "./components/ThemeToggle";

const TheoremExplorer = React.lazy(() => import("./pages/TheoremExplorer"));
const BenchmarkRunner = React.lazy(() => import("./pages/BenchmarkRunner"));
const Leaderboard = React.lazy(() => import("./pages/Leaderboard"));

function App() {
  return (
    <RunnerProvider>
      <div className="app-layout">
        <nav className="sidebar">
          <div className="sidebar-header">
            <h1 className="sidebar-title">PropBench</h1>
            <span className="sidebar-subtitle">Benchmark Suite</span>
          </div>
          <ul className="sidebar-nav">
            <li>
              <NavLink to="/leaderboard">Leaderboard</NavLink>
            </li>
            <li>
              <NavLink to="/" end>
                Dashboard
              </NavLink>
            </li>
            <li>
              <NavLink to="/theorems">Theorems</NavLink>
            </li>
            <li>
              <NavLink to="/runner">Runner</NavLink>
            </li>
          </ul>
          <div className="sidebar-footer">
            <ThemeToggle />
          </div>
        </nav>
        <main className="main-content">
          <Suspense fallback={<div className="loading">Loading...</div>}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/theorems" element={<TheoremExplorer />} />
              <Route path="/runner" element={<BenchmarkRunner />} />
              <Route path="/leaderboard" element={<Leaderboard />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </RunnerProvider>
  );
}

export default App;
