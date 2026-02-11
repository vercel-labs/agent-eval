/**
 * Project initialization - create new eval projects.
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import pkg from '../../package.json' with { type: 'json' };

/**
 * Options for initializing a new project.
 */
export interface InitOptions {
  /** Project name */
  name: string;
  /** Target directory (defaults to current working directory) */
  targetDir?: string;
}

/**
 * Template file definitions.
 */
interface TemplateFile {
  path: string;
  content: string;
}

/**
 * Get the package.json template.
 */
function getPackageJson(projectName: string): string {
  return JSON.stringify(
    {
      name: projectName,
      version: '0.0.1',
      private: true,
      type: 'module',
      devDependencies: {
        '@vercel/agent-eval': `^${pkg.version}`,
        '@types/node': '^22.0.0',
        typescript: '^5.6.0',
        vitest: '^2.1.0',
      },
    },
    null,
    2
  );
}

/**
 * Get the .env.example template.
 */
function getEnvExample(): string {
  return `# API Keys (choose one based on your agent)
# For vercel-ai-gateway agents or to enable failure classification:
AI_GATEWAY_API_KEY=your-ai-gateway-api-key

# For direct Claude Code API:
# ANTHROPIC_API_KEY=sk-ant-...

# For direct OpenAI Codex API:
# OPENAI_API_KEY=sk-proj-...

# Sandbox access - Required (choose ONE of the options below)
# The @vercel/sandbox package automatically detects either token.

# Option 1: Vercel Token (for local development)
# Create at: https://vercel.com/account/tokens
VERCEL_TOKEN=your-vercel-token

# Option 2: OIDC Token (for CI/CD pipelines like GitHub Actions)
# Automatically provided by Vercel's CI integration
# VERCEL_OIDC_TOKEN=your-oidc-token

# Alternative: Use Docker instead of Vercel sandbox (no token needed)
# Set sandbox: 'docker' in your experiment config
`;
}

/**
 * Get the .gitignore template.
 */
function getGitignore(): string {
  return `node_modules/
dist/
.env
.env.local
results/
*.log
.DS_Store
`;
}

/**
 * Get the README.md template.
 */
function getReadme(): string {
  return `# Agent Evaluation Suite

Test AI coding agents to measure what actually works.

## Setup

1. **Install dependencies:**
   \`\`\`bash
   npm install
   \`\`\`

2. **Configure environment variables:**
   \`\`\`bash
   cp .env.example .env.local
   \`\`\`

   Edit \`.env.local\` and add your API keys (see comments in \`.env.example\` for options):
   - **Choose ONE agent key**: \`AI_GATEWAY_API_KEY\` (for Vercel agents), \`ANTHROPIC_API_KEY\`, or \`OPENAI_API_KEY\`
   - **Choose ONE sandbox option**: \`VERCEL_TOKEN\`, \`VERCEL_OIDC_TOKEN\`, or use Docker (set \`sandbox: 'docker'\` in config)

## Running Evals

### Preview (no cost)

See what will run without making API calls:

\`\`\`bash
npx @vercel/agent-eval cc --dry
\`\`\`

### Run Experiments

Run the Claude Code experiment:

\`\`\`bash
npx @vercel/agent-eval cc
\`\`\`

Run the Codex experiment:

\`\`\`bash
npx @vercel/agent-eval codex
\`\`\`

### View Results

Launch the web-based results viewer:

\`\`\`bash
npx @vercel/agent-eval playground
\`\`\`

Open [http://localhost:3000](http://localhost:3000) to browse results.

`;
}

/**
 * Get the default experiment configuration template (Claude Code).
 */
function getCCExperiment(): string {
  return `import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/claude-code',
  runs: 1,
  earlyExit: true,
  scripts: ['build'],
  timeout: 600,
};

export default config;
`;
}

/**
 * Get the Codex experiment configuration template.
 */
function getCodexExperiment(): string {
  return `import type { ExperimentConfig } from '@vercel/agent-eval';

const config: ExperimentConfig = {
  agent: 'vercel-ai-gateway/codex',
  runs: 1,
  earlyExit: true,
  scripts: ['build'],
  timeout: 600,
};

export default config;
`;
}

/**
 * Get the example eval fixture PROMPT.md.
 */
function getExamplePrompt(): string {
  return `Add a greeting message below the heading that says "Welcome, user!"

Requirements:
- Add a paragraph element below the h1
- The text should be exactly "Welcome, user!"
- Keep the existing heading unchanged
`;
}

/**
 * Get the example eval fixture EVAL.ts.
 */
function getExampleEval(): string {
  return `import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { test, expect } from 'vitest';

test('greeting message exists in source', () => {
  const content = readFileSync('src/App.tsx', 'utf-8');
  expect(content).toContain('Welcome, user!');
});

test('app still builds', () => {
  // This throws if the build fails
  execSync('npm run build', { stdio: 'pipe' });
});
`;
}

/**
 * Get the example eval fixture package.json.
 */
function getExamplePackageJson(): string {
  return JSON.stringify(
    {
      name: 'add-greeting',
      type: 'module',
      scripts: {
        build: 'tsc',
      },
      dependencies: {
        react: '^18.0.0',
      },
      devDependencies: {
        '@types/react': '^18.0.0',
        typescript: '^5.0.0',
        vitest: '^2.1.0',
      },
    },
    null,
    2
  );
}

/**
 * Get the root tsconfig.json for the project.
 */
function getRootTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        lib: ['ES2022'],
      },
      include: ['experiments'],
    },
    null,
    2
  );
}

/**
 * Get the example eval fixture tsconfig.json.
 */
function getExampleTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2020',
        module: 'ESNext',
        moduleResolution: 'bundler',
        jsx: 'react-jsx',
        strict: true,
        outDir: 'dist',
        skipLibCheck: true,
      },
      include: ['src'],
    },
    null,
    2
  );
}

/**
 * Get the example eval fixture App.tsx.
 */
function getExampleApp(): string {
  return `export function App() {
  return (
    <div>
      <h1>Hello World</h1>
      {/* TODO: Add greeting message here */}
    </div>
  );
}

export default App;
`;
}

/**
 * Get all template files for a new project.
 */
function getTemplateFiles(projectName: string): TemplateFile[] {
  return [
    { path: 'package.json', content: getPackageJson(projectName) },
    { path: 'tsconfig.json', content: getRootTsconfig() },
    { path: '.env.example', content: getEnvExample() },
    { path: '.gitignore', content: getGitignore() },
    { path: 'README.md', content: getReadme() },
    { path: 'experiments/cc.ts', content: getCCExperiment() },
    { path: 'experiments/codex.ts', content: getCodexExperiment() },
    { path: 'evals/add-greeting/PROMPT.md', content: getExamplePrompt() },
    { path: 'evals/add-greeting/EVAL.ts', content: getExampleEval() },
    { path: 'evals/add-greeting/package.json', content: getExamplePackageJson() },
    { path: 'evals/add-greeting/tsconfig.json', content: getExampleTsconfig() },
    { path: 'evals/add-greeting/src/App.tsx', content: getExampleApp() },
  ];
}

/**
 * Initialize a new eval project.
 */
export function initProject(options: InitOptions): string {
  const targetDir = options.targetDir ?? process.cwd();
  const projectDir = join(targetDir, options.name);

  // Check if directory already exists
  if (existsSync(projectDir)) {
    throw new Error(`Directory already exists: ${projectDir}`);
  }

  // Create project directory
  mkdirSync(projectDir, { recursive: true });

  // Write all template files
  const files = getTemplateFiles(options.name);
  for (const file of files) {
    const filePath = join(projectDir, file.path);
    const fileDir = dirname(filePath);

    // Create parent directories
    mkdirSync(fileDir, { recursive: true });

    // Write file
    writeFileSync(filePath, file.content);
  }

  return projectDir;
}

/**
 * Get instructions for after project creation.
 */
export function getPostInitInstructions(projectDir: string, projectName: string): string {
  return `
Project created at: ${projectDir}

Next steps:
  1. cd ${projectName}
  2. npm install
  3. Copy .env.example to .env and add your API keys
  4. npx agent-eval

For more information, see the documentation at:
  https://github.com/vercel-labs/agent-eval
`;
}
