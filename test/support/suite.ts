import type { Repo } from './repo';

const worker = (docstring: string) => `"""${docstring}"""\n\ndef work():\n    return 1\n`;
const dockerfile = (base: string, digest: string) =>
  `FROM ${base}@sha256:${digest.repeat(64)}\nCOPY src/ /app/\n`;

export function suiteCases(r: Repo, baseline: string) {
  const source = r.commit({ 'apps/worker/src/worker.py': worker('Process queued work.') });
  const hook = r.commit({ 'lefthook.yml': '# Local checks, documented.\npre-commit: {}\n' });
  const images = r.commit({
    'apps/worker/Dockerfile': dockerfile('python', '2'),
    'apps/generator/Dockerfile': dockerfile('bun', '4'),
  });
  const harness = r.commit({
    'apps/mobile/scripts/lib/harness.sh': '#!/bin/sh\nexport JOURNEY_TIMEOUT=60\n',
  });
  return [
    { name: 'baseline', from: baseline, to: baseline, expect: [] },
    {
      name: 'case 4',
      from: baseline,
      to: source,
      expect: [
        'pytest:worker-unit',
        'pytest:worker-acceptance',
        'gate:health',
        'gate:queue',
        'image:worker',
        'native:alpha',
        'native:beta',
        'native:smoke',
        'web:landing',
      ],
    },
    { name: 'case 9', from: source, to: hook, expect: [] },
    {
      name: 'case 10',
      from: hook,
      to: images,
      expect: [
        'image:worker',
        'image:generator',
        'gate:health',
        'gate:queue',
        'pytest:worker-acceptance',
        'native:alpha',
        'native:beta',
        'native:smoke',
        'web:landing',
      ],
    },
    {
      name: 'case 12',
      from: images,
      to: harness,
      expect: ['native:alpha', 'native:beta', 'native:smoke'],
    },
  ];
}

export function suiteFixture(r: Repo) {
  return r.commit({
    'proof.yaml': `version: 1
project: selection-suite
inputs:
  stack:
    - apps/worker/src/**
    - apps/generator/src/**
    - apps/worker/Dockerfile
    - apps/generator/Dockerfile
tasks:
  pytest:worker-unit:
    run: pytest apps/worker/tests/unit
    inputs: [apps/worker/src/**, apps/worker/tests/unit/**]
  pytest:worker-acceptance:
    run: pytest apps/worker/tests/acceptance
    inputs:
      - apps/worker/src/**
      - apps/worker/tests/acceptance/**
      - apps/worker/Dockerfile
      - apps/generator/Dockerfile
  image:worker:
    run: docker build -t worker apps/worker
    inputs: [apps/worker/Dockerfile, apps/worker/src/**]
  image:generator:
    run: docker build -t generator apps/generator
    inputs: [apps/generator/Dockerfile, apps/generator/src/**]
  gate:health:
    run: sh scripts/verify-health.sh
    inputs: [scripts/verify-health.sh, $stack]
  gate:queue:
    run: sh scripts/verify-queue.sh
    inputs: [scripts/verify-queue.sh, $stack]
  native:alpha:
    run: sh apps/mobile/scripts/alpha.sh
    inputs:
      - apps/mobile/scripts/alpha.sh
      - apps/mobile/flows/alpha.yaml
      - apps/mobile/src/alpha/**
      - apps/mobile/scripts/lib/**
      - $stack
  native:beta:
    run: sh apps/mobile/scripts/beta.sh
    inputs:
      - apps/mobile/scripts/beta.sh
      - apps/mobile/flows/beta.yaml
      - apps/mobile/src/beta/**
      - apps/mobile/scripts/lib/**
      - $stack
  native:smoke:
    run: sh apps/mobile/scripts/smoke.sh
    inputs:
      - apps/mobile/scripts/smoke.sh
      - apps/mobile/flows/smoke.yaml
      - apps/mobile/scripts/lib/**
      - $stack
  web:landing:
    run: sh apps/web/scripts/landing.sh
    inputs: [apps/web/scripts/landing.sh, apps/web/src/**, apps/web/e2e/**, $stack]
`,
    'apps/worker/src/worker.py': worker('Process work.'),
    'apps/worker/tests/unit/test_worker.py':
      'from worker import work\n\ndef test_work():\n    assert work() == 1\n',
    'apps/worker/tests/acceptance/test_queue.py':
      'from worker import work\n\ndef test_queue():\n    assert work() == 1\n',
    'apps/worker/Dockerfile': dockerfile('python', '1'),
    'apps/generator/Dockerfile': dockerfile('bun', '3'),
    'apps/generator/src/generate.ts': 'export const generate = () => 1;\n',
    'scripts/verify-health.sh': '#!/bin/sh\ncurl --fail http://localhost:8080/health\n',
    'scripts/verify-queue.sh': '#!/bin/sh\ncurl --fail http://localhost:8080/queue\n',
    'apps/mobile/src/alpha/screen.ts': 'export const title = "Alpha";\n',
    'apps/mobile/src/beta/screen.ts': 'export const title = "Beta";\n',
    'apps/mobile/scripts/alpha.sh':
      '#!/bin/sh\n. apps/mobile/scripts/lib/harness.sh\nmaestro test apps/mobile/flows/alpha.yaml\n',
    'apps/mobile/scripts/beta.sh':
      '#!/bin/sh\n. apps/mobile/scripts/lib/harness.sh\nmaestro test apps/mobile/flows/beta.yaml\n',
    'apps/mobile/scripts/smoke.sh':
      '#!/bin/sh\n. apps/mobile/scripts/lib/harness.sh\nmaestro test apps/mobile/flows/smoke.yaml\n',
    'apps/mobile/scripts/lib/harness.sh': '#!/bin/sh\nexport JOURNEY_TIMEOUT=30\n',
    'apps/mobile/flows/alpha.yaml': 'appId: org.example.mobile\n---\n- launchApp\n- tapOn: Alpha\n',
    'apps/mobile/flows/beta.yaml': 'appId: org.example.mobile\n---\n- launchApp\n- tapOn: Beta\n',
    'apps/mobile/flows/smoke.yaml':
      'appId: org.example.mobile\n---\n- launchApp\n- assertVisible: Home\n',
    'apps/web/scripts/landing.sh': '#!/bin/sh\nbun test apps/web/e2e/landing.test.ts\n',
    'apps/web/src/landing.ts': 'export const title = "Home";\n',
    'apps/web/e2e/landing.test.ts':
      'import { expect, test } from "bun:test";\nimport { title } from "../src/landing";\ntest("landing", () => expect(title).toBe("Home"));\n',
    'lefthook.yml': '# Local checks.\npre-commit: {}\n',
  });
}
