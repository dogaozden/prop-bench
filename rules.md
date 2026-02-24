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
	8.	Constructive Dilemma (CD):
p ∨ q
p ⊃ r
q ⊃ s  /∴  r ∨ s

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