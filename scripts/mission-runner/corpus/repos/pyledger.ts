// ============================================================================
//  corpus repo: pyledger — a small Python double-entry ledger
//  (python3 -m unittest discover -s tests -t .). Base tree is ALL-GREEN.
// ============================================================================
import type { BranchOverlay, FileMap, HelixRepoSpec } from '../contracts.js'

const ACCOUNTS_BASE = `"""Chart of accounts with period balance carry-forward."""


class Account:
    def __init__(self, code, name):
        self.code = code
        self.name = name
        self.balance = 0
        self.opening = 0

    def post(self, amount):
        self.balance += amount


class ChartOfAccounts:
    def __init__(self):
        self._accounts = {}

    def open(self, code, name):
        if code in self._accounts:
            raise ValueError('duplicate account: %s' % code)
        acct = Account(code, name)
        self._accounts[code] = acct
        return acct

    def get(self, code):
        return self._accounts[code]

    def codes(self):
        return sorted(self._accounts)

    def total(self):
        """Sum of all balances (zero for a balanced ledger)."""
        return sum(a.balance for a in self._accounts.values())

    def carry_forward(self):
        """Close the period: each balance becomes the next period's opening.

        This is the ONE place period boundaries are applied; balances persist
        across the boundary in this simplified model.
        """
        for acct in self._accounts.values():
            acct.opening = acct.balance
`

/** reference: total -> grand_total (decoy: parse.total stays). */
const ACCOUNTS_RENAMED = ACCOUNTS_BASE.replace(
  `    def total(self):
        """Sum of all balances (zero for a balanced ledger)."""
        return sum(a.balance for a in self._accounts.values())`,
  `    def grand_total(self):
        """Sum of all balances (zero for a balanced ledger)."""
        return sum(a.balance for a in self._accounts.values())`,
)

const PARSE_BASE = `"""Entry parsing: 'DATE CODE AMOUNT [memo...]' lines; '#' comments.

Amounts are integer cents. Accounting-style parentheses negate:
'(12.34)' == -1234, and a leading '-' also negates.
"""


def parse_amount(token):
    token = token.strip()
    negative = False
    if token.startswith('(') and token.endswith(')'):
        negative = True
        token = token[1:-1]
    if token.startswith('-'):
        negative = True
        token = token[1:]
    if '.' in token:
        whole, frac = token.split('.', 1)
        frac = (frac + '00')[:2]
    else:
        whole, frac = token, '00'
    if whole == '':
        whole = '0'
    cents = int(whole) * 100 + int(frac)
    return -cents if negative else cents


def parse_entries(text):
    entries = []
    for raw in text.splitlines():
        line = raw.strip()
        if line == '' or line.startswith('#'):
            continue
        parts = line.split(None, 3)
        if len(parts) < 3:
            raise ValueError('bad entry line: %r' % raw)
        date, code, amount = parts[0], parts[1], parse_amount(parts[2])
        memo = parts[3] if len(parts) > 3 else ''
        entries.append({'date': date, 'code': code, 'amount': amount, 'memo': memo})
    return entries


def total(entries):
    """Sum of entry amounts in cents (the ENTRY total — unrelated to
    ChartOfAccounts balances)."""
    return sum(e['amount'] for e in entries)
`

/** defect: the parentheses branch is absent — '(12.34)' parses positive. */
const PARSE_NO_PARENS = PARSE_BASE.replace(
  `    token = token.strip()
    negative = False
    if token.startswith('(') and token.endswith(')'):
        negative = True
        token = token[1:-1]
    if token.startswith('-'):`,
  `    token = token.strip()
    negative = False
    if token.startswith('(') and token.endswith(')'):
        token = token[1:-1]
    if token.startswith('-'):`,
)

const REPORT_BASE = `"""Balance reporting with explicit HALF-UP rounding."""

from decimal import Decimal, ROUND_HALF_UP

from .parse import parse_entries, total


def to_currency(cents):
    """Cents -> currency string at 2 places."""
    quant = (Decimal(cents) / Decimal(100)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    return str(quant)


def apply_rate(cents, rate_bp):
    """Apply a basis-point rate to a cent amount, HALF-UP to whole cents
    (ties round AWAY from zero: 12.5 cents -> 13)."""
    raw = Decimal(cents) * Decimal(rate_bp) / Decimal(10000)
    return int(raw.quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def balances(chart):
    return {code: chart.get(code).balance for code in chart.codes()}


def trial_balance(chart):
    """Formatted rows plus the zero-check TOTAL row."""
    rows = []
    for code in chart.codes():
        acct = chart.get(code)
        rows.append('%s %s %s' % (code, acct.name, to_currency(acct.balance)))
    rows.append('TOTAL %s' % to_currency(chart.total()))
    return rows


def post_entries(chart, text):
    entries = parse_entries(text)
    for entry in entries:
        chart.get(entry['code']).post(entry['amount'])
    return total(entries)
`

/** defect: apply_rate rides Python round() (half-EVEN, ties to even). */
const REPORT_ROUND_HALF_EVEN = REPORT_BASE.replace(
  `    raw = Decimal(cents) * Decimal(rate_bp) / Decimal(10000)
    return int(raw.quantize(Decimal('1'), rounding=ROUND_HALF_UP))`,
  `    return int(round(cents * rate_bp / 10000))`,
)

/** reference: report calls the renamed grand_total. */
const REPORT_RENAMED = REPORT_BASE.replace(
  `    rows.append('TOTAL %s' % to_currency(chart.total()))`,
  `    rows.append('TOTAL %s' % to_currency(chart.grand_total()))`,
)

/** reference: thousands separators in trial_balance ONLY. */
const REPORT_SEPARATORS = REPORT_BASE.replace(
  `def trial_balance(chart):
    """Formatted rows plus the zero-check TOTAL row."""
    rows = []
    for code in chart.codes():
        acct = chart.get(code)
        rows.append('%s %s %s' % (code, acct.name, to_currency(acct.balance)))
    rows.append('TOTAL %s' % to_currency(chart.total()))
    return rows`,
  `def _with_separators(currency):
    """Group the integer part with commas ('12345.67' -> '12,345.67')."""
    sign = ''
    text = currency
    if text.startswith('-'):
        sign, text = '-', text[1:]
    whole, frac = text.split('.', 1)
    grouped = '{:,}'.format(int(whole))
    return sign + grouped + '.' + frac


def trial_balance(chart):
    """Formatted rows plus the zero-check TOTAL row (amounts grouped with
    thousands separators; to_currency itself stays plain)."""
    rows = []
    for code in chart.codes():
        acct = chart.get(code)
        rows.append('%s %s %s' % (code, acct.name, _with_separators(to_currency(acct.balance))))
    rows.append('TOTAL %s' % _with_separators(to_currency(chart.total())))
    return rows`,
)

/** falsify: the naive fix — separators inside to_currency (breaks the
 *  green to_currency contract tests). */
const REPORT_SEPARATORS_NAIVE = REPORT_BASE.replace(
  `    quant = (Decimal(cents) / Decimal(100)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    return str(quant)`,
  `    quant = (Decimal(cents) / Decimal(100)).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    return '{:,}'.format(quant)`,
)

// ── helpers task ──────────────────────────────────────────────────────

const HELPERS_SPEC = `# ledger.helpers — the eight helper functions (exact contracts)

Implement every function in \`ledger/helpers.py\` per the contracts below.
Do not change any other file; the tests in \`tests/test_helpers.py\` are the
acceptance oracle.

1. \`fmt_code(code)\` — uppercase the account code and strip surrounding
   whitespace: \`' cash '\` -> \`'CASH'\`.
2. \`is_debit(amount)\` — True when the cent amount is > 0.
3. \`is_credit(amount)\` — True when the cent amount is < 0.
4. \`abs_cents(amount)\` — absolute value of the cent amount.
5. \`sign(amount)\` — -1, 0 or 1.
6. \`split_code(code)\` — split a colon-namespaced code into a (prefix, rest)
   tuple; no colon means the prefix is \`''\` and rest is the whole code:
   \`'assets:cash'\` -> \`('assets', 'cash')\`, \`'cash'\` -> \`('', 'cash')\`.
   Only the FIRST colon splits: \`'a:b:c'\` -> \`('a', 'b:c')\`.
7. \`leaf_code(code)\` — the last colon segment: \`'a:b:c'\` -> \`'c'\`.
8. \`memo_slug(memo)\` — lowercase, spaces collapsed to single hyphens,
   non-alphanumerics (other than hyphens) removed: \`'Pay  Rent!'\` ->
   \`'pay-rent'\`.
`

const HELPERS_STUBS = `"""Small formatting/classification helpers (see SPEC.md)."""


def fmt_code(code):
    raise NotImplementedError


def is_debit(amount):
    raise NotImplementedError


def is_credit(amount):
    raise NotImplementedError


def abs_cents(amount):
    raise NotImplementedError


def sign(amount):
    raise NotImplementedError


def split_code(code):
    raise NotImplementedError


def leaf_code(code):
    raise NotImplementedError


def memo_slug(memo):
    raise NotImplementedError
`

const HELPERS_REFERENCE = `"""Small formatting/classification helpers (see SPEC.md)."""

import re


def fmt_code(code):
    return code.strip().upper()


def is_debit(amount):
    return amount > 0


def is_credit(amount):
    return amount < 0


def abs_cents(amount):
    return abs(amount)


def sign(amount):
    if amount > 0:
        return 1
    if amount < 0:
        return -1
    return 0


def split_code(code):
    if ':' not in code:
        return ('', code)
    prefix, rest = code.split(':', 1)
    return (prefix, rest)


def leaf_code(code):
    return code.rsplit(':', 1)[-1]


def memo_slug(memo):
    text = memo.lower()
    text = re.sub(r'[^a-z0-9 -]', '', text)
    text = re.sub(r' +', '-', text.strip())
    return text
`

/** falsify: plausible-but-wrong (split on the LAST colon; slug keeps
 *  double hyphens). */
const HELPERS_WRONG = HELPERS_REFERENCE.replace(
  `def split_code(code):
    if ':' not in code:
        return ('', code)
    prefix, rest = code.split(':', 1)
    return (prefix, rest)`,
  `def split_code(code):
    if ':' not in code:
        return ('', code)
    prefix, rest = code.rsplit(':', 1)
    return (prefix, rest)`,
)

const TEST_HELPERS = `import unittest

from ledger.helpers import (
    abs_cents,
    fmt_code,
    is_credit,
    is_debit,
    leaf_code,
    memo_slug,
    sign,
    split_code,
)


class TestHelpers(unittest.TestCase):
    def test_fmt_code(self):
        self.assertEqual(fmt_code(' cash '), 'CASH')

    def test_debit_credit(self):
        self.assertTrue(is_debit(1))
        self.assertFalse(is_debit(0))
        self.assertTrue(is_credit(-1))
        self.assertFalse(is_credit(0))

    def test_abs_and_sign(self):
        self.assertEqual(abs_cents(-1234), 1234)
        self.assertEqual(sign(-2), -1)
        self.assertEqual(sign(0), 0)
        self.assertEqual(sign(7), 1)

    def test_split_code(self):
        self.assertEqual(split_code('assets:cash'), ('assets', 'cash'))
        self.assertEqual(split_code('cash'), ('', 'cash'))
        self.assertEqual(split_code('a:b:c'), ('a', 'b:c'))

    def test_leaf_code(self):
        self.assertEqual(leaf_code('a:b:c'), 'c')
        self.assertEqual(leaf_code('cash'), 'cash')

    def test_memo_slug(self):
        self.assertEqual(memo_slug('Pay  Rent!'), 'pay-rent')
        self.assertEqual(memo_slug('July invoice #12'), 'july-invoice-12')
`

// ── base tests ──────────────────────────────────────────────────────────────

const TEST_ACCOUNTS = `import unittest

from ledger.accounts import ChartOfAccounts


class TestAccounts(unittest.TestCase):
    def make_chart(self):
        chart = ChartOfAccounts()
        chart.open('cash', 'Cash')
        chart.open('rent', 'Rent expense')
        return chart

    def test_post_and_balance(self):
        chart = self.make_chart()
        chart.get('cash').post(-120000)
        chart.get('rent').post(120000)
        self.assertEqual(chart.get('cash').balance, -120000)
        self.assertEqual(chart.total(), 0)

    def test_duplicate_open_refuses(self):
        chart = self.make_chart()
        with self.assertRaises(ValueError):
            chart.open('cash', 'Again')

    def test_carry_forward_sets_openings(self):
        chart = self.make_chart()
        chart.get('cash').post(500)
        chart.carry_forward()
        self.assertEqual(chart.get('cash').opening, 500)
        self.assertEqual(chart.get('cash').balance, 500)
`

/** branch tests: the chart total is renamed grand_total. */
const TEST_ACCOUNTS_RENAMED = TEST_ACCOUNTS.replace(
  `        self.assertEqual(chart.total(), 0)`,
  `        self.assertEqual(chart.grand_total(), 0)`,
) + `
    def test_grand_total_is_the_only_chart_total(self):
        chart = self.make_chart()
        self.assertFalse(hasattr(chart, 'total'))
        self.assertEqual(chart.grand_total(), 0)
`

const TEST_PARSE = `import unittest

from ledger.parse import parse_amount, parse_entries, total


class TestParse(unittest.TestCase):
    def test_amounts(self):
        self.assertEqual(parse_amount('12.34'), 1234)
        self.assertEqual(parse_amount('-0.05'), -5)
        self.assertEqual(parse_amount('7'), 700)
        self.assertEqual(parse_amount('.5'), 50)

    def test_entries_and_comments(self):
        text = '# comment line\\n2026-07-01 cash 10.00 float\\n\\n2026-07-02 rent -10.00\\n'
        entries = parse_entries(text)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0]['code'], 'cash')
        self.assertEqual(entries[0]['amount'], 1000)
        self.assertEqual(entries[0]['memo'], 'float')
        self.assertEqual(entries[1]['memo'], '')

    def test_bad_line_refuses(self):
        with self.assertRaises(ValueError):
            parse_entries('2026-07-01 cash')

    def test_entry_total(self):
        entries = parse_entries('2026-07-01 cash 1.00\\n2026-07-01 rent 0.50\\n')
        self.assertEqual(total(entries), 150)
`

const TEST_REPORT = `import unittest

from ledger.accounts import ChartOfAccounts
from ledger.report import apply_rate, balances, post_entries, to_currency, trial_balance


LEDGER_TEXT = (
    '2026-07-01 cash (1200.00) rent out\\n'
    '2026-07-01 rent 1200.00 rent in\\n'
    '2026-07-02 cash 25.50 refund\\n'
    '2026-07-02 fees (25.50) refund fee\\n'
)


class TestReport(unittest.TestCase):
    def make_chart(self):
        chart = ChartOfAccounts()
        chart.open('cash', 'Cash')
        chart.open('rent', 'Rent')
        chart.open('fees', 'Fees')
        return chart

    def test_to_currency(self):
        self.assertEqual(to_currency(1234), '12.34')
        self.assertEqual(to_currency(-5), '-0.05')

    def test_apply_rate_half_up(self):
        self.assertEqual(apply_rate(1250, 100), 13)
        self.assertEqual(apply_rate(250, 500), 13)
        self.assertEqual(apply_rate(1000, 250), 25)

    def test_post_entries_balances(self):
        chart = self.make_chart()
        posted = post_entries(chart, LEDGER_TEXT)
        self.assertEqual(posted, 0)
        self.assertEqual(balances(chart)['cash'], -117450)
        self.assertEqual(balances(chart)['rent'], 120000)
        self.assertEqual(balances(chart)['fees'], -2550)

    def test_trial_balance_total_is_zero(self):
        chart = self.make_chart()
        post_entries(chart, LEDGER_TEXT)
        rows = trial_balance(chart)
        self.assertEqual(rows[-1], 'TOTAL 0.00')
`

/** branch: separators demanded of trial_balance rows (failing test). */
const TEST_REPORT_SEPARATORS = TEST_REPORT + `

class TestTrialBalanceSeparators(unittest.TestCase):
    def test_rows_group_thousands(self):
        chart = ChartOfAccounts()
        chart.open('cash', 'Cash')
        chart.open('loan', 'Loan')
        chart.get('cash').post(123456789)
        chart.get('loan').post(-123456789)
        rows = trial_balance(chart)
        self.assertEqual(rows[0], 'cash Cash 1,234,567.89')
        self.assertEqual(rows[1], 'loan Loan -1,234,567.89')
        self.assertEqual(rows[2], 'TOTAL 0.00')

    def test_to_currency_itself_stays_plain(self):
        self.assertEqual(to_currency(123456789), '1234567.89')
`

// ── comparison-partition overlays (task/cmp-*) ────────────────────

/** defect: the memo maxsplit is absent — multi-word memos lose their tail. */
const PARSE_MEMO_SPLIT = PARSE_BASE.replace(
  `        parts = line.split(None, 3)`,
  `        parts = line.split()`,
)

/** branch: the memo spec (fails under the defect). */
const TEST_MEMO = `import unittest

from ledger.parse import parse_entries


class TestMemo(unittest.TestCase):
    def test_multi_word_memo_survives(self):
        entries = parse_entries('2026-07-01 cash 10.00 monthly rent payment\\n')
        self.assertEqual(entries[0]['memo'], 'monthly rent payment')

    def test_single_word_memo(self):
        entries = parse_entries('2026-07-01 cash 10.00 float\\n')
        self.assertEqual(entries[0]['memo'], 'float')

    def test_short_line_still_refuses(self):
        with self.assertRaises(ValueError):
            parse_entries('2026-07-01 cash')
`

/** defect: post ASSIGNS instead of accumulating — symptom lands in the
 *  report tests (multi-post accounts), while the accounts tests stay green. */
const ACCOUNTS_POST_ASSIGN = ACCOUNTS_BASE.replace(
  `    def post(self, amount):
        self.balance += amount`,
  `    def post(self, amount):
        self.balance = amount`,
)

/** falsify: the plausible sign-flip (still wrong on multi-post). */
const ACCOUNTS_POST_MINUS = ACCOUNTS_BASE.replace(
  `    def post(self, amount):
        self.balance += amount`,
  `    def post(self, amount):
        self.balance -= amount`,
)

/** defect: fraction padding gone — '.5' parses as 5 cents. */
const PARSE_FRAC_NO_PAD = PARSE_BASE.replace(
  `        frac = (frac + '00')[:2]`,
  `        frac = frac[:2]`,
)

const TESTS_INIT = ''

const BASE_FILES: FileMap = {
  '.gitignore': '__pycache__/\n*.pyc\n',
  'ledger/__init__.py': '',
  'ledger/accounts.py': ACCOUNTS_BASE,
  'ledger/parse.py': PARSE_BASE,
  'ledger/report.py': REPORT_BASE,
  'tests/__init__.py': TESTS_INIT,
  'tests/test_accounts.py': TEST_ACCOUNTS,
  'tests/test_parse.py': TEST_PARSE,
  'tests/test_report.py': TEST_REPORT,
}

const BRANCHES: Record<string, BranchOverlay> = {
  'task/rounding-defect': { 'ledger/report.py': REPORT_ROUND_HALF_EVEN },
  'task/rename-decoy': { 'tests/test_accounts.py': TEST_ACCOUNTS_RENAMED },
  'task/misleading': { 'ledger/parse.py': PARSE_NO_PARENS },
  'task/mechanical': {
    'SPEC.md': HELPERS_SPEC,
    'ledger/helpers.py': HELPERS_STUBS,
    'tests/test_helpers.py': TEST_HELPERS,
  },
  'task/trap': { 'tests/test_report.py': TEST_REPORT_SEPARATORS },
  'task/cmp-memo': {
    'ledger/parse.py': PARSE_MEMO_SPLIT,
    'tests/test_memo.py': TEST_MEMO,
  },
  'task/cmp-accounts': { 'ledger/accounts.py': ACCOUNTS_POST_ASSIGN },
  'task/cmp-switch-a': { 'ledger/parse.py': PARSE_FRAC_NO_PAD },
}

export const PYLEDGER_REPO: HelixRepoSpec = {
  id: 'pyledger',
  seed: 'inline',
  files: BASE_FILES,
  branches: BRANCHES,
}

export const PYLEDGER_CONTENT = {
  PARSE_BASE,
  REPORT_BASE,
  ACCOUNTS_RENAMED,
  REPORT_RENAMED,
  REPORT_SEPARATORS,
  REPORT_SEPARATORS_NAIVE,
  HELPERS_REFERENCE,
  HELPERS_WRONG,
  TEST_REPORT,
  ACCOUNTS_BASE,
  ACCOUNTS_POST_MINUS,
} as const
