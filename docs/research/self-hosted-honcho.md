# Self-hosted Honcho deployment research

Researched on 2026-08-24 for Argus issue #3 against the current default branches
of Plastic Labs Honcho (`da4b3ee`) and Hermes Agent (`f14059f`), plus the
community `elkimek/honcho-self-hosted` repository (`c2120b0`). Only first-party
source repositories and their checked-in documentation were used.

## Recommendation

Use the current `plastic-labs/honcho` repository and its own
`docker-compose.yml.example`. Do **not** copy the community repository's
`config.toml`, `.env`, or compose file onto current upstream Honcho unchanged.

`elkimek/honcho-self-hosted` gets the integration boundary right: Hermes already
accepts a local `baseUrl`, and current Hermes can send a self-hosted JWT without
any Hermes code changes. However, the community server configuration is stale
relative to current Honcho:

- It disables server auth, so a bearer token is ignored and an “authenticated”
  workspace-list call cannot prove authentication.
- Its model configuration uses the former `PROVIDER` / `MODEL` fields and
  `LLM_VLLM_*`, `LLM_EMBEDDING_*`, and `LLM_OPENAI_COMPATIBLE_*` environment
  variables. Current Honcho instead uses nested `model_config` objects,
  supports the `openai`, `anthropic`, and `gemini` transports, and reads
  `LLM_OPENAI_API_KEY`, `LLM_ANTHROPIC_API_KEY`, or `LLM_GEMINI_API_KEY`.
  Because unknown settings are ignored, copying the community files can silently
  fall back to current Honcho's direct-OpenAI defaults instead of the intended
  OpenRouter/Venice route.
- Its installer is Ubuntu-specific (`apt-get`, `usermod`, GNU `sed -i`) and is
  not an appropriate automation path for this macOS host.
- Its API port is published on all host interfaces (`8000:8000`), whereas
  current upstream binds API, Postgres, and Redis to `127.0.0.1`.
- It copies the JSON file but does not activate `memory.provider: honcho` in
  current Hermes or ensure Hermes' optional `honcho-ai` dependency is installed.
  Its optional MCP path also patches upstream source in place.

The community claim is therefore best read as “no Hermes source patch is
needed,” which is true, not “these deployment files remain drop-in compatible
with every future Honcho checkout.”

## Deployed result

Ticket #3 was deployed from upstream Honcho commit `da4b3ee` in `~/honcho`.
The macOS host uses Colima's headless Docker runtime, installed as a Homebrew
login service. The upstream Compose stack runs API, Deriver, Postgres/pgvector,
and Redis with `restart: unless-stopped`; Postgres, Redis, and LanceDB use named
volumes. A stop/start of the runtime confirmed that all four containers return
automatically.

Authentication is enabled with a locally generated `AUTH_JWT_SECRET`. A local
admin JWT is stored, mode `0600`, in both `~/.honcho/config.json` and
`~/.hermes/.env`; the secret itself remains only in `~/honcho/.env`, also mode
`0600`. The shared JSON contains root `apiKey`, `environmentUrl`, and `baseUrl`,
plus a Hermes host block containing its explicit local `apiKey` and `baseUrl`.
No workspace identifier is configured.

The deployed model route uses the existing OpenRouter credential on this host:
`z-ai/glm-4.7-flash` for Deriver, Dialectic, Summary, and Dream, and
`openai/text-embedding-3-small` for embeddings. Every enabled feature is
explicitly pointed at OpenRouter rather than relying on upstream defaults.

Verification on 2026-08-24 produced:

- `GET http://localhost:8000/health`: HTTP 200, `{"status":"ok"}`.
- Workspace list without a bearer token: HTTP 401, proving auth is enforced.
- Authenticated `POST /v3/workspaces/list?page=1&size=50`: HTTP 200 with
  `total=0`, proving JWT validation, migrations, and the database query work
  without creating an Argus workspace.
- The authenticated list remained HTTP 200 with `total=0` after restarting the
  supervised Docker runtime.

Hermes's `honcho-ai` optional dependency is present in its lockfile and plugin
manifest. Its `memory.provider` remains deliberately inactive: activation may
create the default Hermes workspace and belongs to the later `argus init` flow,
not this provisioning ticket.

Sources:

- [Community claim and manual copy procedure](https://github.com/elkimek/honcho-self-hosted/blob/c2120b0544da52953ad7e8c09fdb3f0e9c80c4aa/README.md#L1-L5)
- [Community environment variables](https://github.com/elkimek/honcho-self-hosted/blob/c2120b0544da52953ad7e8c09fdb3f0e9c80c4aa/env.example#L1-L20)
- [Community model/auth schema](https://github.com/elkimek/honcho-self-hosted/blob/c2120b0544da52953ad7e8c09fdb3f0e9c80c4aa/config.toml#L16-L70)
- [Community compose port and persistence configuration](https://github.com/elkimek/honcho-self-hosted/blob/c2120b0544da52953ad7e8c09fdb3f0e9c80c4aa/docker-compose.yml#L10-L87)
- [Current upstream model schema and supported transports](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/config.toml.example#L53-L86)
- [Current upstream deriver `model_config`](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/config.toml.example#L88-L143)
- [Hermes local-JWT setup path](https://github.com/NousResearch/hermes-agent/blob/f14059fad20e17acf2512785114791566e70bd06/plugins/memory/honcho/cli.py#L573-L625)
- [Community installer's config-only Hermes step and optional source patch](https://github.com/elkimek/honcho-self-hosted/blob/c2120b0544da52953ad7e8c09fdb3f0e9c80c4aa/setup.sh#L261-L300)
- [Current Hermes Honcho plugin dependency](https://github.com/NousResearch/hermes-agent/blob/f14059fad20e17acf2512785114791566e70bd06/plugins/memory/honcho/plugin.yaml#L1-L5)

## Exact upstream deployment

Use a durable checkout directory because its named Docker volumes and `.env`
belong to the long-running installation:

```bash
git clone https://github.com/plastic-labs/honcho.git ~/honcho
cd ~/honcho
cp docker-compose.yml.example docker-compose.yml
cp .env.template .env
```

Configure `~/honcho/.env` with an existing provider key and local authentication.
For a direct OpenAI key, the smallest complete provider configuration is:

```dotenv
LLM_OPENAI_API_KEY=<existing OpenAI API key>

# Explicit although it is the current built-in default: frequent derivation uses
# the small model rather than inheriting an accidental future large-model choice.
DERIVER_MODEL_CONFIG__TRANSPORT=openai
DERIVER_MODEL_CONFIG__MODEL=gpt-5.4-mini
DERIVER_MODEL_CONFIG__THINKING_EFFORT=minimal

# Required for a real authenticated verification rather than auth bypass.
AUTH_USE_AUTH=true
AUTH_JWT_SECRET=<64-hex-character secret>
```

Generate the auth secret with the checked-in upstream utility:

```bash
python3 scripts/generate_jwt_secret.py --print-only
```

The current defaults route all text-generation features (Deriver, Dialectic,
Summary, and Dream) through `openai / gpt-5.4-mini`, and message embeddings
through `openai / text-embedding-3-small`; one direct OpenAI API key therefore
covers the complete stack. `EMBED_MESSAGES` defaults to true and should remain
enabled for Argus semantic recall. If an OpenAI-compatible proxy key is used
instead, every enabled feature's nested model and base URL must be overridden,
not just the Deriver; the upstream `.env.template` enumerates the exact nested
environment names. Models must support tool/function calling.

Start and inspect the stack:

```bash
cd ~/honcho
docker compose up -d --build
docker compose ps
curl --fail-with-body --silent --show-error http://localhost:8000/health
docker compose logs deriver --tail 20
```

The stack contains four services: API, Deriver, Postgres with pgvector, and
Redis. The API is `http://localhost:8000`; Postgres and Redis are available only
at `127.0.0.1:5432` and `127.0.0.1:6379`. The API container runs database
migrations before FastAPI starts, and the Deriver waits for the API healthcheck,
which prevents it racing migrations.

Sources:

- [Current official Docker steps and four-service topology](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/docs/v3/contributing/self-hosting.mdx#L66-L117)
- [Current provider requirements and OpenAI-compatible override example](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/docs/v3/contributing/self-hosting.mdx#L35-L59)
- [Current upstream localhost bindings, healthcheck, dependencies, and volumes](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/docker-compose.yml.example#L12-L149)
- [API entrypoint runs migrations before FastAPI](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/docker/entrypoint.sh#L1-L8)
- [Upstream secret generator](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/scripts/generate_jwt_secret.py#L1-L35)

## Local authentication and read-only verification

Self-hosted Honcho's “API key” is an HS256 JWT signed with
`AUTH_JWT_SECRET`. Generate an admin JWT after the authenticated stack is up:

```bash
cd ~/honcho
docker compose exec -T api \
  /app/.venv/bin/python scripts/generate_jwt.py --admin --print-only
```

Use the returned value as `HONCHO_API_KEY`. An admin JWT is required because the
current workspace enumeration route is:

```text
POST /v3/workspaces/list?page=1&size=50
```

and the route declares `require_auth(admin=True)`. Verify without creating a
workspace:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  --url 'http://localhost:8000/v3/workspaces/list?page=1&size=50' \
  --header "Authorization: Bearer $HONCHO_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"filters": {}}'
```

HTTP 200 with a paginated object is success; `items: []` is the expected clean
state and creates nothing. For stronger evidence that auth is active, the same
request with no `Authorization` header must return 401. The `/health` endpoint
alone is insufficient: it intentionally checks only that the API process is up,
not Postgres or the LLM provider. The authenticated list call covers routing,
JWT validation, migrations, and a real database query, but still does not call
the model provider. Inspecting a healthy Deriver process verifies startup only;
an eventual message-ingestion test under `argus init` must verify real derivation.

Sources:

- [Authentication enablement and JWT utilities](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/README.md#L379-L413)
- [Admin/scoped JWT generator](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/scripts/generate_jwt.py#L55-L144)
- [Workspace-list route and admin requirement](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/src/routers/workspaces.py#L69-L92)
- [Auth-disabled bypass versus JWT verification](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/src/security.py#L202-L225)
- [Healthcheck's deliberately shallow contract](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/docs/v3/contributing/self-hosting.mdx#L253-L277)

## Shared client configuration

Current Honcho CLI and Hermes use different URL keys in the same shared JSON:
the CLI owns `environmentUrl`, while Hermes reads `baseUrl`. The CLI reads the
root `apiKey`; for authenticated self-hosting Hermes' setup deliberately stores
the local JWT under `hosts.hermes.apiKey` so it is explicitly treated as a local
credential and remains separate from any future cloud key. A compatible shared
shape is therefore:

```json
{
  "apiKey": "<admin JWT>",
  "environmentUrl": "http://localhost:8000",
  "baseUrl": "http://localhost:8000",
  "hosts": {
    "hermes": {
      "enabled": true,
      "apiKey": "<same admin JWT>",
      "baseUrl": "http://localhost:8000",
      "aiPeer": "hermes"
    }
  }
}
```

Write that to `~/.honcho/config.json` with mode `0600`. Do not add an Argus
workspace here: per-repository workspace creation and binding belong to
`argus init`. Mirror the connection in `~/.hermes/.env`:

```dotenv
HONCHO_URL=http://localhost:8000
HONCHO_API_KEY=<same admin JWT>
```

The host-block key is important even though `HONCHO_API_KEY` is also present.
For a local URL, Hermes intentionally ignores an env-only key as potentially a
cloud credential and substitutes the unauthenticated `local` placeholder; an
explicit key in the JSON host/root is what opts into local JWT auth. No Hermes
source change is necessary. Separately, current Hermes must have
`memory.provider: honcho` active and its optional `honcho-ai` package available;
the community installer does neither. Check those before enabling Hermes, but do
not run a setup path that eagerly creates the default `hermes` workspace during
ticket #3.

Sources:

- [Honcho CLI shared-file ownership and URL/key names](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/honcho-cli/src/honcho_cli/config.py#L1-L23)
- [CLI loading of `environmentUrl` and root `apiKey`](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/honcho-cli/src/honcho_cli/config.py#L175-L215)
- [Hermes config path and host/root/env resolution](https://github.com/NousResearch/hermes-agent/blob/f14059fad20e17acf2512785114791566e70bd06/plugins/memory/honcho/client.py#L538-L623)
- [Hermes explicit-local-key behavior](https://github.com/NousResearch/hermes-agent/blob/f14059fad20e17acf2512785114791566e70bd06/plugins/memory/honcho/client.py#L1317-L1357)
- [Hermes' documented authenticated self-host setup](https://github.com/NousResearch/hermes-agent/blob/f14059fad20e17acf2512785114791566e70bd06/website/docs/user-guide/features/honcho.md#L105-L112)
- [Hermes provider activation gate](https://github.com/NousResearch/hermes-agent/blob/f14059fad20e17acf2512785114791566e70bd06/agent/agent_init.py#L1870-L1883)

## Persistence and operational caveats

- Postgres persists in the named `pgdata` volume and Redis in `redis-data`.
  `docker compose down` preserves them; `docker compose down -v` deletes them.
  The unused-by-default `lancedb-data` volume is also declared for installations
  that opt into LanceDB.
- Every service uses `restart: unless-stopped`. Containers return when the Docker
  engine restarts unless explicitly stopped, but on macOS the Docker runtime
  itself must be configured to start at login for unattended host-reboot
  recovery. This deployment runs Colima as a Homebrew login service.
- Back up Postgres, not Redis, as the durable memory source:
  `docker compose exec database pg_dump -U postgres postgres > backup.sql`.
- Keep the checkout path and Compose project name stable. Moving/renaming it can
  cause Compose to address a different set of project-prefixed named volumes.
- Keep `~/honcho/.env`, `AUTH_JWT_SECRET`, the admin JWT, and
  `~/.honcho/config.json` private. Rotating `AUTH_JWT_SECRET` invalidates every
  minted JWT; mint and rewire a replacement after rotation.
- Current compose publishes Postgres with `POSTGRES_HOST_AUTH_METHOD=trust` but
  binds it to loopback. Do not broaden that port binding without hardening the
  database configuration.
- The server image is built from source; pinning a known commit makes updates
  deliberate. After pulling an update, rebuild so migrations run before the API
  and retain a database backup.
- Self-hosted Honcho has no service-plan or per-workspace quota. Practical limits
  are local disk/CPU/RAM, database sizing, and the configured model provider's
  own rate and spend limits. The similarly named
  `WEBHOOK_MAX_WORKSPACE_LIMIT=10` limits webhook endpoints **within** one
  workspace; it is not a workspace-count limit. Workspace enumeration is
  paginated at 50 by default and 100 maximum per page, so later Argus code must
  paginate. This fits Argus's later one-workspace-per-repository design, but
  workspace creation remains outside ticket #3.

Sources:

- [Named volumes and restart policies](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/docker-compose.yml.example#L12-L149)
- [Official backup/restore commands](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/docs/v3/contributing/self-hosting.mdx#L397-L405)
- [Official production/auth/database cautions](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/docs/v3/contributing/self-hosting.mdx#L343-L377)
- [Webhook limit applies per workspace](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/src/crud/webhook.py#L38-L56)
- [Workspace-list pagination bounds](https://github.com/plastic-labs/honcho/blob/da4b3ee43578fb9ec22ac27aec23ad0369dc6d47/docs/v3/openapi.json#L63-L108)
