// Sets up the PHP-team workflow for one or all projects.
// Run: node scripts/setup-php-workflow.mjs [projectId]
// Adds Tech Lead, Architect, PHP Junior, PHP Senior templates if missing,
// then writes a workflow:
//   tech_lead --route:architect--> architect --> php_junior
//             --route:dev-------------------------> php_junior  (default next)
//   php_junior --> php_senior (retry: php_junior, max 2)
//   php_senior --> reviewer   (retry: php_junior, max 2)
//   reviewer   --> tester
//   tester     --> END

const BASE = process.env.CEO_API ?? "http://localhost:4000";

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

const TEMPLATES_TO_ENSURE = ["tech_lead", "architect", "php_junior", "php_senior", "closer"];

async function ensureAgents(projectId) {
  const existing = await api("GET", `/api/projects/${projectId}/agents`);
  const haveByName = new Set(existing.map((a) => a.name));
  const templateNameByKey = {
    tech_lead: "Tech Lead",
    architect: "Architect",
    php_junior: "PHP Junior Coder",
    php_senior: "PHP Senior Coder",
    closer: "Closer",
  };
  for (const key of TEMPLATES_TO_ENSURE) {
    if (haveByName.has(templateNameByKey[key])) {
      console.log(`  ✓ ${templateNameByKey[key]} already present`);
      continue;
    }
    await api("POST", `/api/projects/${projectId}/agents/from-template/${key}`);
    console.log(`  + added ${templateNameByKey[key]}`);
  }
}

async function buildWorkflow(projectId) {
  const agents = await api("GET", `/api/projects/${projectId}/agents`);
  const byName = (n) => agents.find((a) => a.name === n);

  const tl = byName("Tech Lead");
  const arch = byName("Architect");
  const junior = byName("PHP Junior Coder");
  const senior = byName("PHP Senior Coder");
  const reviewer = byName("Reviewer");
  const tester = byName("Tester");
  const closer = byName("Closer");
  const missing = [
    ["Tech Lead", tl], ["Architect", arch],
    ["PHP Junior Coder", junior], ["PHP Senior Coder", senior],
    ["Reviewer", reviewer], ["Tester", tester],
    ["Closer", closer],
  ].filter(([_, a]) => !a).map(([n]) => n);
  if (missing.length > 0) {
    throw new Error(`missing agents in project: ${missing.join(", ")}`);
  }

  const wf = {
    project_specifics: "PHP project. Follow PSR-12, declare(strict_types=1) at the top of every PHP file, type-hint all parameters and returns. Use the project's framework conventions (composer.json reveals which one). Tests live next to the code under test (PHPUnit or Pest).",
    phases: [
      // n8n-style layout: square nodes 180px apart; branch (architect) at y=80.
      {
        id: "tech_lead",
        agent_id: tl.id,
        next: "php_junior",
        routes: { architect: "architect", dev: "php_junior" },
        position: { x: 60, y: 240 },
      },
      {
        id: "architect",
        agent_id: arch.id,
        next: "php_junior",
        position: { x: 240, y: 80 },
      },
      {
        id: "php_junior",
        agent_id: junior.id,
        next: "php_senior",
        position: { x: 420, y: 240 },
      },
      {
        id: "php_senior",
        agent_id: senior.id,
        next: "reviewer",
        position: { x: 600, y: 240 },
      },
      {
        id: "reviewer",
        agent_id: reviewer.id,
        next: "ci_gate",
        retry_target: "php_senior",
        max_attempts: 2,
        position: { x: 780, y: 240 },
      },
      // Deterministic CI gate placed BEFORE the tester. Runs `composer ci`
      // INSIDE THE PROJECT'S DOCKER CONTAINER — that's the only env where
      // PHP/extensions/composer are guaranteed to match production. If a repo
      // has docker-compose.yml + composer.json, build + one-shot `compose run`
      // (no port mapping, auto-cleanup, idempotent across parallel runs).
      // Convention: service name matches repo directory name (api, plant-api).
      {
        id: "ci_gate",
        kind: "task",
        task: {
          type: "shell",
          config: {
            command: [
              "set -e",
              "docker network create agarden 2>/dev/null || true",
              "fail=0",
              "for D in */; do",
              "  REPO=\"${D%/}\"",
              "  [ -d \"$D\" ] || continue",
              "  [ -f \"$D/composer.json\" ] || continue",
              "  echo \"::: ci_gate $REPO :::\"",
              "  if [ -f \"$D/docker-compose.yml\" ]; then",
              "    (cd \"$D\" && docker compose build --pull --quiet && docker compose run --rm \"$REPO\" sh -c \"composer install --no-interaction --no-progress 2>&1 && composer ci 2>&1\") || { echo \"ci failed in $REPO\"; fail=1; }",
              "  else",
              "    (cd \"$D\" && composer install --no-interaction --no-progress && composer ci) || { echo \"ci failed in $REPO (no docker-compose.yml)\"; fail=1; }",
              "  fi",
              "done",
              "exit $fail",
            ].join("\n"),
            timeout_sec: 1500,
          },
        },
        next: "tester",
        retry_target: "php_senior",
        max_attempts: 2,
        position: { x: 960, y: 240 },
      },
      {
        id: "tester",
        agent_id: tester.id,
        next: "closer",
        retry_target: "php_senior",
        max_attempts: 2,
        position: { x: 1140, y: 240 },
      },
      {
        id: "closer",
        agent_id: closer.id,
        next: null,
        retry_target: "php_senior",
        max_attempts: 2,
        position: { x: 1320, y: 240 },
      },
    ],
  };

  await api("PUT", `/api/projects/${projectId}/workflow`, wf);
  console.log(`  ✓ workflow written (${wf.phases.length} phases)`);
}

async function setup(projectId) {
  const project = await api("GET", `/api/projects/${projectId}`);
  console.log(`\n[${project.name}] (${projectId})`);
  await ensureAgents(projectId);
  await buildWorkflow(projectId);
}

const target = process.argv[2];
const projects = target
  ? [{ id: target }]
  : await api("GET", "/api/projects");

for (const p of projects) {
  try {
    await setup(p.id);
  } catch (e) {
    console.error(`  ✗ ${e.message}`);
  }
}
console.log("\nDone.");
