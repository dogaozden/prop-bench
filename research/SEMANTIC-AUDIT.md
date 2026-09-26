# Independent semantic audit of v2

The accompanying `v2-semantic-audit.json` is generated from all 24 public theorem
files using the script below. It independently parses the shipped notation and
enumerates every valuation of each item's atoms. It does not call logic-core,
read planted proof files, infer a shortest proof, or run a model.

Checks: exact manifest hashes; entailment; satisfiable premises; non-tautologous
conclusion; minimum number of premises semantically sufficient; and whether a
single premise is equivalent to the conclusion. The last two describe semantic
shortcuts, not violations of the proof protocol. Parentheses, square brackets,
and braces group identically; precedence is negation, conjunction, disjunction,
implication (right associative), biconditional (left associative).

Run this block from the repository root. It rewrites only the audit JSON.

```sh
python3 - <<'PY'
import datetime, hashlib, itertools, json, pathlib, re

def parse(text):
    tokens = re.findall(r'<>|[A-Z][A-Za-z0-9_]*|[~.v>#()\[\]{}]', text)
    if ''.join(tokens) != re.sub(r'\s+', '', text):
        raise ValueError('Unsupported token: ' + text)
    pos = 0
    precedence = {'<>': 10, '>': 20, 'v': 30, '.': 40}
    def expression(minimum=0):
        nonlocal pos
        token = tokens[pos]
        pos += 1
        if token == '~':
            left = ('~', expression(50))
        elif token in '([{':
            left = expression()
            assert tokens[pos] == {'(': ')', '[': ']', '{': '}'}[token]
            pos += 1
        elif token == '#' or re.fullmatch(r'[A-Z][A-Za-z0-9_]*', token):
            left = ('atom', token)
        else:
            raise ValueError('Unexpected token: ' + token)
        while pos < len(tokens) and precedence.get(tokens[pos], -1) >= minimum:
            op = tokens[pos]
            pos += 1
            right = expression(precedence[op] + (op != '>'))
            left = (op, left, right)
        return left
    result = expression()
    assert pos == len(tokens), (text, tokens[pos:])
    return result

def evaluate(node, valuation):
    op = node[0]
    if op == 'atom':
        return False if node[1] == '#' else valuation[node[1]]
    left = evaluate(node[1], valuation)
    if op == '~':
        return not left
    right = evaluate(node[2], valuation)
    return {'.': left and right, 'v': left or right,
            '>': not left or right, '<>': left == right}[op]

assert parse('P > Q > R') == parse('P > (Q > R)')
for values in itertools.product([False, True], repeat=3):
    v = dict(zip('PQR', values))
    assert evaluate(parse('~(P . Q) <> (~P v ~Q)'), v)
    assert evaluate(parse('((P > Q) . P) > Q'), v)
    assert evaluate(parse('(P v Q) . R'), v) == ((v['P'] or v['Q']) and v['R'])

root = pathlib.Path('golf/set/v2')
manifest_bytes = (root / 'manifest.json').read_bytes()
manifest = json.loads(manifest_bytes)
items = []
for item in manifest['items']:
    raw = (root / (item['id'] + '.json')).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == item['theorem_sha256']
    theorem = json.loads(raw)
    formulas = theorem['premises'] + [theorem['conclusion']]
    nodes = list(map(parse, formulas))
    atoms = sorted(set(re.findall(r'[A-Z][A-Za-z0-9_]*', ' '.join(formulas))))
    rows = [[evaluate(node, dict(zip(atoms, values))) for node in nodes]
            for values in itertools.product([False, True], repeat=len(atoms))]
    n = len(theorem['premises'])
    def entails(indices):
        return all(not all(row[i] for i in indices) or row[-1] for row in rows)
    assert entails(range(n)), theorem['id']
    sufficient = next(k for k in range(n + 1)
                      if any(entails(c) for c in itertools.combinations(range(n), k)))
    equivalent = [i + 1 for i in range(n) if all(row[i] == row[-1] for row in rows)]
    items.append({'id': item['id'], 'band': int(item['id'][1]),
                  'par': item['par'], 'theorem_sha256': item['theorem_sha256'],
                  'atom_count': len(atoms), 'premise_count': n,
                  'valuation_count': len(rows), 'entailed': entails(range(n)),
                  'premises_satisfiable': any(all(row[:-1]) for row in rows),
                  'conclusion_tautology': all(row[-1] for row in rows),
                  'minimum_sufficient_premises': sufficient,
                  'proper_subset_sufficient': sufficient < n,
                  'equivalent_premise_numbers': equivalent})

def summarize(group):
    return {'items': len(group),
            'entailed': sum(x['entailed'] for x in group),
            'unsatisfiable_premises': sum(not x['premises_satisfiable'] for x in group),
            'tautologous_conclusion': sum(x['conclusion_tautology'] for x in group),
            'proper_subset_sufficient': sum(x['proper_subset_sufficient'] for x in group),
            'premise_equivalent_conclusion': sum(bool(x['equivalent_premise_numbers']) for x in group),
            'par_min': min(x['par'] for x in group),
            'par_max': max(x['par'] for x in group)}

record = {'schema': 'propbench-semantic-audit-v1',
          'audited_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'source': 'golf/set/v2',
          'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
          'method': 'independent parser and exhaustive truth tables; no proof search',
          'summary': summarize(items),
          'bands': {str(b): summarize([x for x in items if x['band'] == b])
                    for b in [1, 2, 3]}, 'items': items}
pathlib.Path('research/v2-semantic-audit.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record['summary'], indent=2))
PY
```
