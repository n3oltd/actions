# pick-runner

Picks a job's runner: the self-hosted **`github-runner`** fleet when it has idle capacity,
otherwise a GitHub-hosted fallback (`ubuntu-latest`). Centralises the "is there self-hosted
capacity?" check so every repo references it instead of copy-pasting the script — a workflow
prefers self-hosted but never queues behind a saturated fleet.

- **Public repos** always get the hosted fallback (the self-hosted runner group is
  private-repo only).
- Needs a token with **Organization self-hosted runners: read** (the default `GITHUB_TOKEN`
  can't list org runners) — e.g. the n3o-babar App token minted by `n3o-git-identity`.

## Usage

Run it in a small `pick` job, then feed its output to the real job's `runs-on`:

```yaml
jobs:
  pick:
    runs-on: ubuntu-latest
    outputs:
      runs-on: ${{ steps.p.outputs.runs-on }}
    steps:
      - id: identity
        uses: n3oltd/actions/.github/actions/n3o-git-identity@main
        with:
          app-id: ${{ secrets.N3O_APP_ID }}
          private-key: ${{ secrets.N3O_APP_PRIVATE_KEY }}
      - id: p
        uses: n3oltd/actions/.github/actions/pick-runner@main
        with:
          token: ${{ steps.identity.outputs.token }}

  build:
    needs: pick
    runs-on: ${{ needs.pick.outputs.runs-on }}
    steps:
      - ...
```

## Inputs

| input | default | description |
| --- | --- | --- |
| `token` | — (required) | Token with org self-hosted-runners read. |
| `self-hosted-label` | `github-runner` | Self-hosted label to prefer. |
| `fallback` | `ubuntu-latest` | Hosted runner used when the fleet is saturated. |
| `org` | `n3oltd` | Org that owns the runners. |
