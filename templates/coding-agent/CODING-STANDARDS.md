# Coding Standards — CTO Division

Standards for all CTO division projects. Every project should feel built by the same team.

---

## Stack

- **Framework:** Next.js (App Router)
- **Language:** TypeScript (strict mode)
- **Styling:** Tailwind CSS
- **Deployment:** Vercel
- **Version Control:** GitHub
- **Package Manager:** pnpm

---

## Project Structure

```
project-name/
├── README.md
├── .env.example
├── .gitignore
├── next.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── package.json
├── pnpm-lock.yaml
├── docs/
│   ├── SPEC.md
│   ├── ARCHITECTURE.md
│   ├── STATUS.md
│   └── DECISIONS.md
├── public/
├── src/
│   ├── app/
│   ├── components/
│   │   ├── ui/           ← Reusable primitives
│   │   └── features/     ← Feature-specific components
│   ├── lib/
│   ├── hooks/
│   ├── types/
│   └── services/         ← API clients
```

---

## Naming

- **Files:** kebab-case (`user-profile.tsx`)
- **Components:** PascalCase (`UserProfile`)
- **Functions:** camelCase (`getUserData`)
- **Types:** PascalCase (`UserProfile`)
- **Constants:** SCREAMING_SNAKE_CASE (`MAX_RETRIES`)
- **CSS:** Tailwind utilities only

---

## Component Patterns

- Prefer server components. Use `'use client'` only for interactivity/hooks/browser APIs.
- Keep files <150 lines. Break into smaller pieces if larger.
- Co-locate component-specific types with the component file.
- Props interfaces: `{ComponentName}Props`.

---

## API Routes

- Use Next.js Route Handlers in `src/app/api/`
- Return proper HTTP status codes
- Validate inputs before processing
- Handle errors gracefully — no raw error messages to client
- Use TypeScript for request/response shapes

---

## State Management

- React server components + server actions for data fetching when possible.
- Client state: React hooks (useState, useReducer).
- Complex client state: Zustand if needed.
- No Redux. No Context API for state management.

---

## Error Handling

- Every API call must have error handling.
- User-facing errors: clear and actionable ("Unable to load data. Try refreshing.").
- Log errors server-side with context.
- Never show stack traces to users.

---

## Performance

- Use `next/image` with proper sizing.
- Lazy load heavy components.
- Type and validate API responses.
- Keep bundle lean — no unnecessary client-side JavaScript.

---

## Git

- **Branches:** `feature/short-description`, `fix/short-description`
- **Commits:** Present tense, imperative ("Add dashboard," "Fix overflow")
- **One logical change per commit** — no unrelated bundling.
- **Never commit:** `.env` files, `node_modules`, build artifacts, IDE config.

---

## README

Written for a human engineer who's never seen the project:

1. What it is (one paragraph)
2. How to run locally (clone to running dev server)
3. Environment variables (what's needed, where to get them)
4. Project structure (directory layout)
5. Deployment (how it gets to Vercel)
6. Current state (link to docs/STATUS.md)

---

## .env.example

Every env var with:
- Descriptive comment explaining what it's for
- Service/provider it comes from
- Placeholder format showing expected shape

```
# Database connection (Neon/Supabase/PlanetScale)
DATABASE_URL=postgresql://user:password@host:5432/dbname

# OpenAI API key (get from platform.openai.com)
OPENAI_API_KEY=sk-...
```

---
