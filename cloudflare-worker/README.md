# GitHub Stars Vectorize Worker

Minimal Cloudflare Worker acting as a proxy for Cloudflare Vectorize. The frontend generates embeddings, while the Worker handles vector storage, querying, and deletion.

## Prerequisites

- [Cloudflare Account](https://dash.cloudflare.com/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- Logged in to Wrangler (`wrangler login`)

## Initial Deployment

### 1. Create a Vectorize Index

The index dimensions must match your chosen embedding model:

```bash
# OpenAI text-embedding-3-small (1536 dimensions)
npx wrangler vectorize create github-stars --dimensions=1536 --metric=cosine

# Ollama nomic-embed-text (768 dimensions)
npx wrangler vectorize create github-stars --dimensions=768 --metric=cosine

# Cohere embed-multilingual-v3.0 (1024 dimensions)
npx wrangler vectorize create github-stars --dimensions=1024 --metric=cosine

# Gemini text-embedding-004 (768 dimensions)
npx wrangler vectorize create github-stars --dimensions=768 --metric=cosine

# SiliconFlow BAAI/bge-large-zh-v1.5 (1024 dimensions)
npx wrangler vectorize create github-stars --dimensions=1024 --metric=cosine
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Auth Token

```bash
wrangler secret put AUTH_TOKEN
# Enter a secure random string, e.g., openssl rand -hex 32
```

### 4. Deploy

```bash
npm run deploy
```

After successful deployment, Wrangler will output the Worker URL, similar to:
```text
https://github-stars-vectorize.<your-subdomain>.workers.dev
```

### 5. Configure in the App

In GitHub Stars Manager under **Settings → Vector Search**:
- **Worker URL**: Enter the URL from the previous step
- **Auth Token**: Enter the AUTH_TOKEN value you set

### 6. Test the Connection

Click **Test Worker Connection** on the settings page until you see "Connection successful".

---

## Updating the Deployment (After Code Changes)

When you update the Worker code (e.g., after pulling a new version from GitHub), redeploy it:

```bash
cd cloudflare-worker

# If dependencies changed (package.json was updated)
npm install

# Redeploy
npm run deploy
```

> **Note**: Redeploying **does not** require recreating the Vectorize index; existing vector data remains intact.

---

## Changing Embedding Models

> ⚠️ **You must rebuild the index after changing models!** Different models generate vectors with different dimensions; mixing them will cause queries to fail.

Steps:
1. Change the embedding model in App settings
2. If the new model's dimensions differ from the old one, **delete the old index and create a new one**:
   ```bash
   # Delete old index
   npx wrangler vectorize delete github-stars

   # Create new index (matching the new model dimensions)
   npx wrangler vectorize create github-stars --dimensions=1024 --metric=cosine
   ```
3. In the App, click **Rebuild Vector Index**

---

## File Descriptions

| File | Description |
|------|-------------|
| `src/index.ts` | Worker source code (TypeScript, used for CLI deployment) |
| `worker.js` | Worker code (plain JS, fallback) |
| `wrangler.toml` | Wrangler deployment configuration |
| `package.json` | Dependency declarations |

## API Endpoints

| Method | Path | Description |
|------|------|-------------|
| POST | `/upsert` | Batch upsert vectors |
| POST | `/query` | Vector similarity search |
| POST | `/delete` | Delete specified vectors |
| POST | `/cleanup` | Clean up vectors not in the `keepIds` list |
| GET | `/status` | Get index status |

All requests require the `Authorization: Bearer <AUTH_TOKEN>` header.

## Local Development

```bash
npm run dev
```

## Common Embedding Model Dimensions Reference

| Model | Dimensions | Multilingual | Pricing |
|------|------|--------|------|
| OpenAI text-embedding-3-small | **1536** | ✅ | $0.02/M |
| OpenAI text-embedding-3-large | **3072** | ✅ | $0.13/M |
| Gemini text-embedding-004 | **768** | ✅ | Free |
| Cohere embed-multilingual-v3.0 | **1024** | ✅ | $0.1/M |
| Ollama nomic-embed-text | **768** | ✅ | Free |
| Ollama bge-m3 | **1024** | ✅ | Free |
| SiliconFlow BAAI/bge-large-zh-v1.5 | **1024** | ✅ | ¥0.5/M |
