// Repository-wide static checks, executed through the plugin package.
import { ESLint } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';
import { parse as parseHtml } from 'parse5';
import { parse as parseCss } from 'css-tree';
import { parseDocument } from 'yaml';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others',
  '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'))]
  .filter(file => file && existsSync(join(root, file))).sort();
const failures = [];
const rules = {
  'no-unused-vars': ['error', { vars: 'all', args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-unreachable': 'error', 'no-dupe-args': 'error', 'no-dupe-keys': 'error',
  'no-dupe-class-members': 'error', 'no-func-assign': 'error', 'no-import-assign': 'error',
  'valid-typeof': 'error', 'constructor-super': 'error', 'no-this-before-super': 'error',
  'no-unexpected-multiline': 'error', 'no-unsafe-finally': 'error', 'no-undef': 'error',
};
const linter = new ESLint({ cwd: root, overrideConfigFile: true, ignore: false, overrideConfig: [
  { files: ['**/*.js', '**/*.mjs', '**/*.ts'], languageOptions: { ecmaVersion: 'latest',
    sourceType: 'module', globals: { ...globals.node, ...globals.browser, ...globals.es2025, Charts: 'readonly' } }, rules },
  { files: ['**/*.ts'], languageOptions: { parser: tsParser }, plugins: { '@typescript-eslint': tsPlugin },
    rules: { 'no-unused-vars': 'off', 'no-undef': 'off', 'no-dupe-class-members': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }] } },
  // Assignments and type aliases in this file are compiler assertions, including
  // @ts-expect-error cases. The consumer-types gate validates them with tsc.
  { files: ['plugin/scripts/test-types.ts'], rules: { '@typescript-eslint/no-unused-vars': 'off' } },
] });
const code = files.filter(file => /\.(?:js|mjs|ts)$/.test(file));
const reports = await linter.lintFiles(code.map(file => join(root, file)));
let inlineScripts = 0, cssFiles = 0, configFiles = 0, shellFiles = 0;
for (const file of files) {
  const path = join(root, file);
  if (/\.(?:html|css|json|ya?ml)$/.test(file)) {
    const text = readFileSync(path, 'utf8');
    if (file.endsWith('.html')) {
      const document = parseHtml(text);
      const visit = async node => {
        if (node.tagName === 'script' && !node.attrs?.some(attr => attr.name === 'src')) {
          const script = (node.childNodes || []).filter(child => child.nodeName === '#text')
            .map(child => child.value).join('');
          if (script.trim()) {
            inlineScripts++;
            reports.push(...await linter.lintText(script, { filePath: path + '.inline.js' }));
          }
        }
        for (const child of node.childNodes || []) await visit(child);
      };
      await visit(document);
    } else if (file.endsWith('.css')) {
      cssFiles++;
      parseCss(text, { positions: true, onParseError: error => failures.push({
        file, line: error.line, message: error.message,
      }) });
    } else {
      configFiles++;
      if (file.endsWith('.json')) {
        try { JSON.parse(text); } catch (error) { failures.push({ file, message: error.message }); }
      } else {
        for (const error of parseDocument(text).errors) failures.push({ file, message: error.message });
      }
    }
  }
  if (file.endsWith('.sh')) {
    shellFiles++;
    const result = spawnSync('bash', ['-n', path], { encoding: 'utf8' });
    if (result.status !== 0) failures.push({ file, message: result.stderr || result.error?.message });
  }
}
for (const report of reports) for (const message of report.messages) failures.push({
  file: relative(root, report.filePath), line: message.line, rule: message.ruleId, message: message.message,
});
const pythonFiles = files.filter(file => file.endsWith('.py'));
const python = process.env.WECHAT_TEST_PYTHON || (existsSync(join(root, '.venv/bin/python'))
  ? join(root, '.venv/bin/python') : 'python3');
const ruff = spawnSync(python, ['-m', 'ruff', 'check', '--isolated', '--select', 'E9,F',
  '--output-format', 'json', ...pythonFiles.map(file => join(root, file))], { encoding: 'utf8', timeout: 120000 });
try {
  for (const issue of JSON.parse(ruff.stdout)) failures.push({ file: relative(root, issue.filename),
    line: issue.location.row, rule: issue.code, message: issue.message });
  if (ruff.status !== 0 && failures.length === 0) failures.push({ tool: 'ruff', message: ruff.stderr });
} catch {
  failures.push({ tool: 'ruff', message: 'Install requirements-dev.txt before running quality checks. ' + (ruff.stderr || ruff.error?.message || '') });
}
console.log(JSON.stringify({ passed: failures.length === 0, files: files.length, jsTsFiles: code.length,
  inlineScripts, pythonFiles: pythonFiles.length, cssFiles, configFiles, shellFiles, failures }, null, 2));
if (failures.length) process.exitCode = 1;
