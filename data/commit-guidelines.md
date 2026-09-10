<!--
Commit message formatting reference for Hack Club YSWS projects.
Source: https://gist.github.com/FaizeenHoque/0709576cc598721df07fb62d2430e6fe
Added to the shared Pixie corpus so every program channel can answer
"how should I format my commits / what does a good commit message look like".
-->

# Git Commit Guidelines

This document defines how commits should be made in this repository.

The goal is to keep the Git history **clear, searchable, consistent, and useful to future developers**. A commit should explain what changed and, when necessary, why it changed.

---

## When to Make Commits

Make a commit when you have completed a **logical, self-contained change**.

A good commit should generally represent **one thing**:

* A new feature
* A bug fix
* A refactor
* A documentation change
* A test
* A performance improvement
* A dependency/build change
* A configuration change

### Good times to commit

```text
Implemented user authentication
        ↓
       COMMIT

Fixed authentication redirect bug
        ↓
       COMMIT

Added tests for authentication
        ↓
       COMMIT
```

Each commit represents a meaningful step in the project's development.

### Avoid committing too often

Do not create commits for every tiny action:

```text
❌ changed variable
❌ changed variable again
❌ fixed typo
❌ actually fixed typo
❌ added one line
```

Instead, group related changes into a coherent unit:

```text
✅ refactor: simplify authentication state handling
```

### Avoid huge unrelated commits

Do not combine unrelated work:

```text
❌ feat: add login, redesign navbar, update dependencies,
   fix database bug, and rewrite README
```

Prefer separate commits:

```text
feat: add user authentication
fix: prevent duplicate database entries
docs: update setup instructions
chore: update dependencies
```

This makes individual changes easier to review and revert.

---

# Commit Structure

Commits should follow the **Conventional Commits** format:

```text
<type>[optional scope]: <description>

[optional body]

[optional footer]
```

For example:

```text
feat(auth): add password reset flow

Allow users to request a password reset email and
set a new password using the generated token.

Closes #42
```

---

## 1. Subject / Description

The first line should be short and immediately explain the change.

### Rules

* Keep it ideally under **50 characters**
* Use lowercase when using Conventional Commits
* Do not end it with a period
* Use the **imperative mood**
* Be specific
* Avoid unnecessary filler

### Imperative mood

Write the subject as if completing:

> "If applied, this commit will..."

```text
✅ If applied, this commit will add user authentication

❌ If applied, this commit will added user authentication
❌ If applied, this commit will adding user authentication
```

Good examples:

```text
feat: add dark mode
fix: prevent duplicate requests
docs: update installation guide
refactor: simplify API client
test: add authentication tests
```

Bad examples:

```text
❌ fixed stuff
❌ changes
❌ update
❌ made some improvements
❌ oops
❌ I think I fixed it
```

The freeCodeCamp guide specifically recommends concise, direct subjects and imperative wording.

---

# Commit Types

Use one of the following types:

| Type       | Use for                                          |
| ---------- | ------------------------------------------------ |
| `feat`     | Adding a new feature                             |
| `fix`      | Fixing a bug                                     |
| `refactor` | Restructuring code without changing behavior     |
| `docs`     | Documentation changes                            |
| `test`     | Adding or modifying tests                        |
| `style`    | Formatting changes that don't affect behavior    |
| `perf`     | Performance improvements                         |
| `build`    | Build system or dependency changes               |
| `ci`       | CI/CD configuration                              |
| `chore`    | Maintenance that doesn't affect application code |
| `revert`   | Reverting a previous commit                      |

These types are based on the Conventional Commits structure described in the freeCodeCamp guide.

### Examples

```text
feat: add image upload support

fix: prevent crash when file is missing

refactor: simplify database connection logic

docs: add development setup instructions

test: add tests for user registration

perf: reduce image processing time

build: update TypeScript version

ci: add automated test workflow

chore: remove unused dependencies

revert: revert image upload changes
```

---

# Scopes

A scope can optionally be used to indicate which part of the project was changed.

Format:

```text
type(scope): description
```

Examples:

```text
feat(auth): add password reset

fix(api): handle invalid requests

docs(readme): update installation steps

test(database): add migration tests

refactor(ui): simplify navigation component
```

Scopes are optional. Use them when they make the commit easier to understand.

---

# When to Write a Commit Body

The subject should be enough for simple changes.

For larger or less obvious changes, add a body.

```text
fix(api): prevent duplicate requests

The API could previously send multiple requests when the
user clicked the submit button repeatedly.

Disable the button while the request is pending so only
one request can be processed at a time.
```

The body should explain **why** the change was made and provide useful context.

Do not simply describe the code line-by-line.

### Prefer

```text
fix(ui): prevent navigation overlap

The navigation items could overlap the logo on smaller
screens. Increase the spacing and allow the navigation
container to wrap.
```

### Instead of

```text
fix(ui): change margin

Changed margin from 10px to 20px.
```

The code already tells you what changed.

The commit message should preserve the reasoning behind the change — something that may not be obvious months later.

---

# Commit Body Formatting

When using a body:

* Leave a blank line between the subject and body
* Keep body lines around **72 characters**
* Explain **what** changed and especially **why**
* Include relevant context
* Avoid unnecessary details

Example:

```text
fix(parser): handle empty input

The parser previously crashed when given an empty input
file. Return an empty result instead so callers can safely
process files with no content.
```

---

# What to Include in a Commit

A good commit should answer:

### What changed?

What did this commit actually modify?

```text
feat: add CSV export
```

### Why was it changed?

Why was the change necessary?

```text
Users need a way to export their data for use in external
spreadsheet applications.
```

### What effect does it have?

Explain important behavioral or architectural consequences.

```text
The export endpoint now generates CSV files instead of
returning JSON.
```

For simple changes, the subject alone may be enough.

---

# Breaking Changes

If a commit introduces a change that may require existing users or code to be updated, clearly document it.

Example:

```text
feat(api): change authentication response format

Authentication responses now return the user object under
the `data` property.

BREAKING CHANGE: clients must read the user from
`response.data.user` instead of `response.user`.
```

Breaking changes should never be hidden in a vague commit message.

---

# Issues and References

When a commit relates to an issue, pull request, or task, reference it when appropriate.

```text
fix(auth): prevent expired token errors

Refresh authentication tokens before they expire.

Closes #42
```

This creates a useful connection between the Git history and the project's issue tracker.

---

# Commit Examples

## Good

```text
feat: add user registration

fix: prevent duplicate form submissions

fix(api): handle expired authentication tokens

refactor(database): simplify connection handling

docs: add local development instructions

test(auth): add login validation tests

perf(images): reduce thumbnail processing time

chore: update dependencies
```

## Bad

```text
❌ update

❌ changes

❌ fixed bug

❌ stuff

❌ final

❌ final final

❌ small changes

❌ fixed everything

❌ hopefully fixed it

❌ misc updates
```

A commit message should still make sense when viewed months or years later.

---

# Before Committing

Before creating a commit:

```bash
git status
git diff
git diff --staged
```

Check that:

* You are committing the intended files
* No unrelated changes are included
* Secrets or credentials are not being committed
* Generated files are not accidentally included
* The code is in a reasonable working state
* The commit represents one logical change

Then stage the relevant files:

```bash
git add <files>
```

Review the staged changes:

```bash
git diff --staged
```

Then commit:

```bash
git commit -m "feat: add user registration"
```

---

# Amending Commits

If you just made a commit and forgot something minor, you can amend it:

```bash
git add forgotten-file
git commit --amend --no-edit
```

To change the message:

```bash
git commit --amend -m "feat: add user registration"
```

Amending replaces the previous commit with a new commit.

### Important

Avoid amending commits that have already been pushed to a shared branch unless you know exactly what you are doing.

An amended commit has a new commit hash and can require history rewriting on the remote repository.

---

# Commit Checklist

Before committing, ask:

```text
[ ] Does this commit represent one logical change?
[ ] Is the message specific?
[ ] Does it use the correct commit type?
[ ] Is the subject written in imperative mood?
[ ] Is the subject concise?
[ ] Does it avoid unnecessary punctuation?
[ ] Does the message explain why when necessary?
[ ] Are unrelated changes excluded?
[ ] Have I reviewed the staged diff?
[ ] Have I avoided committing secrets or credentials?
```

If all relevant boxes are checked, commit.

---

# Quick Reference

## Format

```text
type(scope): description

optional body

optional footer
```

## Common Types

```text
feat      New feature
fix       Bug fix
refactor  Code restructuring
docs      Documentation
test      Tests
style     Formatting
perf      Performance
build     Build/dependencies
ci        CI/CD
chore     Maintenance
revert    Revert commit
```

## Examples

```text
feat(auth): add password reset

fix(api): handle invalid JSON

refactor(ui): simplify navigation

docs: update installation guide

test(auth): add login tests

perf: optimize image processing

chore: update dependencies
```

---

# Philosophy

Git commits are more than checkpoints.

They are a **historical record of the project**.

Write commits for the person who will eventually run:

```bash
git log
```

and ask:

> "Why was this change made?"

A good commit should make the answer obvious.

The extra time spent writing a useful commit message can save significant time later when debugging, reviewing history, reverting changes, or understanding old decisions.
