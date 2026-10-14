# Contributing

Thanks for looking. telepi is small on purpose, and most of what makes it useful is what it chooses not to build. Read this before opening a pull request.

## What telepi is, and is not

telepi puts existing parts together so a coding agent can work unattended without being able to harm the machine it runs on:

- **Pi Durable** runs the agent loop on the trusted side. telepi does not write an agent harness and does not fork Pi.
- **NVIDIA OpenShell** is the sandbox, the network policy and the credential boundary.
- **Pi's own files** (`~/.pi/agent`) are the model login and settings.
- **telepi** is the phone app, a thin server and the adapter between them.

So a change that adds agent behaviour (tools, prompts, memory, model routing) belongs in a Pi Durable extension or upstream in Pi, not in telepi. A change that adds a safety mechanism should use what OpenShell offers before adding a check of our own: the sandbox boundary is the only source of approvals, and telepi does not try to recognise dangerous commands. If you are unsure, open an issue first and describe the problem rather than the solution.

## Getting set up

```
./install.sh                 # checks Node and pnpm, installs, runs `pnpm telepi setup`
pnpm telepi doctor           # what is missing, and how to fix it
```

For UI work no gateway or model is needed:

```
VITE_MOCK=1 pnpm --filter @telepi/web dev       # the app with mock data; see apps/web/src/data/mock for ?switches
TELEPI_RUNTIME=fake pnpm --filter @telepi/server dev   # a server that plays scripted tasks
```

See [docs/reference.md](docs/reference.md) for the real agent, the environment variables and how the parts fit.

## Before you open a pull request

- `pnpm -r typecheck` and `pnpm --filter @telepi/web build` pass. CI runs the same.
- There are no automated tests yet, by decision: changes are checked by running them. Say in the pull request what you ran and what you saw. For UI changes, include screenshots at phone width (about 360 px), in light and dark.
- Types shared by the app and the server live in `packages/contract`. Change them there first, and keep stored data from older versions readable.
- Everything is in English: code, comments, UI text and docs.
- UI text is short and plain. Say what happened and what to do next, without jargon. Colour is used only for state (running, waiting on you, done, failed).
- Match the style of the code around your change, including how much it comments.
- Never commit secrets, a Pi `auth.json`, the gateway certificates in `deploy/openshell/tls`, or a `.env` file.

## Security

Please do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).
