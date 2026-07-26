'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const SCAN_ROOTS = ['lib', 'src', 'dashboard', 'scripts'];
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.html']);

function toRepositoryPath(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join('/');
}

function shouldExclude(relativePath) {
  return /(?:^|\/)(?:tests|docs|legacy|archives?)(?:\/|$)/.test(relativePath)
    || /(?:^|\/)src\/db\/migrations(?:\/|$)/.test(relativePath)
    || /(?:^|\/)(?:legacy-)?bot-instructions-migrator\.js$/.test(relativePath);
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolutePath));
    else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(absolutePath);
  }
  return files;
}

function sourceFiles() {
  return SCAN_ROOTS
    .flatMap(root => walk(path.join(repositoryRoot, root)))
    .map(absolutePath => ({
      absolutePath,
      relativePath: toRepositoryPath(absolutePath),
      source: fs.readFileSync(absolutePath, 'utf8'),
    }))
    .filter(file => !shouldExclude(file.relativePath));
}

function matchingLines(source, expression) {
  return source.split(/\r?\n/).flatMap((line, index) => (
    expression.test(line) ? [{ line: index + 1, text: line.trim() }] : []
  ));
}

function findOccurrences(expression, { allow = () => false, allowOccurrence = () => false } = {}) {
  return sourceFiles().flatMap(file => {
    if (allow(file)) return [];
    return matchingLines(file.source, expression)
      .filter(match => !allowOccurrence({ ...file, ...match }))
      .map(match => ({ file: file.relativePath, ...match }));
  });
}

function formatOccurrences(occurrences) {
  return occurrences.map(({ file, line, text }) => `${file}:${line} ${text}`).join('\n');
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function sourceExists(relativePath) {
  return fs.existsSync(path.join(repositoryRoot, relativePath));
}

module.exports = {
  findOccurrences,
  formatOccurrences,
  readSource,
  sourceExists,
};
