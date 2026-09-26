Valid Forms for Sentential Logic

Valid Argument Forms of Inference
	1.	Modus Ponens (MP):
p ⊃ q
p  /∴  q
	2.	Modus Tollens (MT):
p ⊃ q
~ q  /∴  ~ p
	3.	Disjunctive Syllogism (DS):
p ∨ q
~ p  /∴  q
p ∨ q
~ q  /∴  p
	4.	Simplification (Simp):
p · q  /∴  p
p · q  /∴  q
	5.	Conjunction (Conj):
p
q  /∴  p · q
	6.	Hypothetical Syllogism (HS):
p ⊃ q
q ⊃ r  /∴  p ⊃ r
	7.	Addition (Add):
p  /∴  p ∨ q
p  /∴  q ∨ p   (house form: the premise may take either side)
	8.	Constructive Dilemma (CD):
p ∨ q
p ⊃ r
q ⊃ s  /∴  r ∨ s

Negation Elimination (NegE):
p
~p  /∴  #
Here # denotes contradiction. This is a ninth inference rule; the historical
numbering of the eighteen forms below is retained for reference.

⸻

Valid Equivalence Forms (Rule of Replacement)
	9.	Double Negation (DN):
p :: ~~ p
	10.	DeMorgan’s Theorem (DeM):
~ (p · q) :: (~ p ∨ ~ q)
~ (p ∨ q) :: (~ p · ~ q)
	11.	Commutation (Comm):
(p ∨ q) :: (q ∨ p)
(p · q) :: (q · p)
	12.	Association (Assoc):
[p ∨ (q ∨ r)] :: [(p ∨ q) ∨ r]
[p · (q · r)] :: [(p · q) · r]
	13.	Distribution (Dist):
[p · (q ∨ r)] :: [(p · q) ∨ (p · r)]
[p ∨ (q · r)] :: [(p ∨ q) · (p ∨ r)]
	14.	Contraposition (Contra):
(p ⊃ q) :: (~ q ⊃ ~ p)
	15.	Implication (Impl):
(p ⊃ q) :: (~ p ∨ q)
	16.	Exportation (Exp):
[(p · q) ⊃ r] :: [p ⊃ (q ⊃ r)]
	17.	Tautology (Taut):
p :: (p · p)
p :: (p ∨ p)
	18.	Equivalence (Equiv):
(p ≡ q) :: [(p ⊃ q) · (q ⊃ p)]
(p ≡ q) :: [(p · q) ∨ (~ p · ~ q)]

⸻

Conditional and Indirect Proof

Conditional Proof
(Assume p … derive q)
AP  /∴  q
∴ p ⊃ q  CP

Indirect Proof
(Assume ~ p … derive q · ~ q)
AP  /∴  p
∴ p  IP

The verifier also accepts assuming p and deriving a contradiction to conclude
~p. A contradiction can be # or a conjunction A · ~A. CP/IP scopes may be
nested; a line inside a closed scope cannot be cited outside it. CP can close
an assumption immediately (the same start and end line) to derive p ⊃ p.

All equivalence rules are bidirectional. The pinned v0.3.4 engine selects a
structural subformula at any depth and replaces all identical occurrences of
that subformula together. For example, DN can transform P · P into ~~P · ~~P
in one line. Inference rules apply to complete cited lines.
Premises are numbered automatically and do not count toward proof length.
Every submitted assumption, derivation, and CP/IP closing line counts once.
In the new track protocol, depth and the cited CP/IP ranges must match the
scope derived by the verifier. The legacy replay command ignored these claimed
scope fields; new tracks use the strict protocol without changing old results.
