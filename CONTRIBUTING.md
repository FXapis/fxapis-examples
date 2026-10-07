# Contributing

Thanks for the interest in improving these examples.

## What's welcome

- Fixing a bug or an outdated API call.
- Clarifying a comment or a step that was confusing.
- A small, focused example in the existing style (one file, one scenario).

## What isn't

- New dependencies. The Node examples use only the `fxapis` SDK and built-ins; the Python
  examples use only `fxapis` (which depends only on `httpx`).
- Anything that trades without the `FXAPIS_EXAMPLES_TRADE=1` guard, or that trades more than
  0.01 lots in a demo.

## Before you open a pull request

1. Run the example locally against a broker **demo account** and confirm it still works.
2. For Node: `cd node && npm run check` (type-checks with no emit).
3. For Python: `python -m py_compile python/*.py` and ideally `mypy --strict python/*.py`.
4. For shell: `shellcheck curl/*.sh`.

These are exactly the checks the `check` GitHub Actions workflow runs on every push.

## Reporting a problem

Open an [issue](https://github.com/FXapis/fxapis-examples/issues) with the example file, what you
expected, and what happened — the response `requestId` if you have one, so we can find the exact
call. Found an API or billing bug rather than an examples bug? Email
[support@fxapis.com](mailto:support@fxapis.com) instead.
