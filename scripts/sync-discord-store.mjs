#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import YAML from "yaml";

const guildId = process.env.DISCORD_GUILD_ID ?? "1069483280438673418";
const forums = [
  { kind: "plugins", channelId: process.env.DISCORD_PLUGINS_FORUM_ID ?? "1077886267464892468" },
  { kind: "themes", channelId: process.env.DISCORD_THEMES_FORUM_ID ?? "1077886317364523072" },
];

const token = process.env.DISCORD_BOT_TOKEN;
const githubToken = process.env.GITHUB_TOKEN;
const limit = Number(process.env.DISCORD_FORUM_LIMIT ?? 50);
const apiBase = "https://discord.com/api/v10";

if (!token) {
  console.error("Missing DISCORD_BOT_TOKEN environment variable.");
  process.exit(1);
}

async function main() {
  const listings = [];

  for (const forum of forums) {
    const posts = await fetchForumPosts(forum);
    for (const post of posts) {
      const listing = await normalizePost(forum.kind, post);
      if (listing) listings.push(listing);
    }
  }

  listings.sort((a, b) => {
    const left = Date.parse(a.updatedAt ?? "") || 0;
    const right = Date.parse(b.updatedAt ?? "") || 0;
    return right - left || a.name.localeCompare(b.name);
  });

  const registry = {
    name: "Pengu Community Store registry",
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      guildId,
      forums: forums.map((forum) => ({ kind: forum.kind, channelId: forum.channelId })),
    },
    listings,
  };

  await mkdir("registry", { recursive: true });
  await writeFile("registry/store.json", `${JSON.stringify(registry, null, 2)}\n`);
  await writeFile("registry/store.yml", YAML.stringify(registry));

  console.log(`Wrote ${listings.length} listings to registry/store.json and registry/store.yml.`);
}

async function fetchForumPosts(forum) {
  const [channel, active, archived] = await Promise.all([
    discord(`/channels/${forum.channelId}`),
    discord(`/guilds/${guildId}/threads/active`),
    discord(`/channels/${forum.channelId}/threads/archived/public?limit=${Math.min(limit, 100)}`),
  ]);

  const threads = dedupeById([
    ...(active.threads ?? []).filter((thread) => thread.parent_id === forum.channelId),
    ...(archived.threads ?? []),
  ]).slice(0, limit);

  return Promise.all(threads.map(async (thread) => {
    const firstMessages = await fetchFirstMessages(thread.id);
    const tags = (thread.applied_tags ?? [])
      .map((id) => channel.available_tags?.find((entry) => entry.id === id)?.name)
      .filter(Boolean);

    return {
      id: thread.id,
      name: thread.name,
      createdAt: snowflakeToIso(thread.id),
      updatedAt: thread.last_message_id ? snowflakeToIso(thread.last_message_id) : snowflakeToIso(thread.id),
      tags,
      messages: firstMessages,
      discordUrl: `https://discord.com/channels/${guildId}/${thread.id}/${thread.id}`,
    };
  }));
}

async function fetchFirstMessages(threadId) {
  try {
    const after = (BigInt(threadId) - 1n).toString();
    const messages = await discord(`/channels/${threadId}/messages?after=${after}&limit=5`);
    return [...messages]
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
      .slice(0, 5)
      .map(compactMessage);
  } catch (error) {
    console.warn(`Failed to read first messages for ${threadId}: ${error.message}`);
    return [];
  }
}

async function normalizePost(kind, post) {
  const github = pickGithubRepo(post.messages);
  const [repo, release] = github
    ? await Promise.all([
        githubJson(`https://api.github.com/repos/${github.owner}/${github.repo}`),
        githubJson(`https://api.github.com/repos/${github.owner}/${github.repo}/releases/latest`),
      ])
    : [null, null];

  const details = github && repo?.default_branch
    ? await fetchGithubDescription(github, repo.default_branch)
    : null;
  const attachments = post.messages.flatMap((message) => message.attachments ?? []);

  return {
    id: post.id,
    kind,
    name: post.name,
    description: repo?.description || cleanDescription(post.messages[0]?.content) || release?.name || "No description provided.",
    details: details ?? release?.body ?? undefined,
    repo: repo?.html_url ?? github?.url,
    releaseUrl: release?.html_url,
    releaseTag: release?.tag_name,
    releaseName: release?.name,
    image: pickImage(post.messages, repo, github),
    author: {
      name: repo?.owner?.login ?? post.messages[0]?.author?.globalName ?? post.messages[0]?.author?.username ?? "Community",
      avatar: repo?.owner?.avatar_url,
      github: repo?.owner?.login,
    },
    tags: post.tags,
    discordUrl: post.discordUrl,
    upvotes: highestReactionCount(post.messages),
    updatedAt: release?.published_at ?? repo?.pushed_at ?? repo?.updated_at ?? post.updatedAt,
    assets: release?.assets?.map((asset) => ({
      name: asset.name ?? "download",
      size: asset.size ?? 0,
      downloadUrl: asset.browser_download_url ?? "",
      contentType: asset.content_type,
    })).filter((asset) => asset.downloadUrl)
      ?? attachments.filter(isDownloadAttachment).map((asset) => ({
        name: asset.filename ?? "download",
        size: asset.size ?? 0,
        downloadUrl: asset.url,
        contentType: asset.contentType,
      })),
    enriched: true,
  };
}

async function discord(path) {
  const response = await fetch(`${apiBase}${path}`, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "PenguStoreSync (https://github.com/PenguLoader/plugin-store)",
    },
  });

  if (!response.ok) throw new Error(`Discord ${response.status} for ${path}: ${await response.text()}`);
  return response.json();
}

async function githubJson(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "PenguStoreSync (https://github.com/PenguLoader/plugin-store)",
  };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  return response.json();
}

async function fetchGithubDescription(ref, branch) {
  for (const file of ["description.md", "DESCRIPTION.md", "Description.md"]) {
    const response = await fetch(`https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${branch}/${file}`);
    if (response.ok) return response.text();
  }
  return null;
}

function compactMessage(message) {
  return {
    id: message.id,
    createdAt: snowflakeToIso(message.id),
    author: message.author
      ? {
          id: message.author.id,
          username: message.author.username,
          globalName: message.author.global_name,
        }
      : null,
    content: message.content ?? "",
    embeds: message.embeds ?? [],
    attachments: (message.attachments ?? []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      contentType: attachment.content_type,
      size: attachment.size,
      url: attachment.url,
      proxyUrl: attachment.proxy_url,
      width: attachment.width,
      height: attachment.height,
    })),
    reactions: (message.reactions ?? []).map((reaction) => ({
      count: reaction.count ?? 0,
      name: reaction.emoji?.name,
      id: reaction.emoji?.id,
    })),
  };
}

function pickGithubRepo(messages) {
  return extractUrls(messages)
    .map(parseGithubUrl)
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)[0];
}

function extractUrls(messages) {
  const text = messages.map((message) => [
    message.content ?? "",
    ...(message.embeds ?? []).flatMap((embed) => [
      embed.url,
      embed.title,
      embed.description,
      embed.thumbnail?.url,
      embed.image?.url,
    ]),
  ].filter(Boolean).join("\n")).join("\n");

  return [...new Set(text.match(/https?:\/\/[^\s<>)"']+/gi)?.map((url) => url.replace(/[.,;:!?]+$/, "")) ?? [])];
}

function parseGithubUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") return null;

    const [owner, repo, ...rest] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo) return null;

    const cleanRepo = repo.replace(/\.git$/, "");
    const path = rest.join("/");
    let score = 10;

    if (path.startsWith("releases")) score += 30;
    if (path === "releases/latest") score += 20;
    if (path.startsWith("releases/tag/")) score += 15;
    if (owner.toLowerCase() === "penguloader") score -= 30;
    if (owner.toLowerCase() === "penguloader" && cleanRepo.toLowerCase() === "penguloader") score -= 50;

    return { owner, repo: cleanRepo, url: `https://github.com/${owner}/${cleanRepo}`, path, score };
  } catch {
    return null;
  }
}

function pickImage(messages, repo, ref) {
  const attachment = messages
    .flatMap((message) => message.attachments ?? [])
    .find((item) => item.contentType?.startsWith("image/") && (item.proxyUrl || item.url));
  if (attachment) return attachment.proxyUrl ?? attachment.url;

  const embedImage = messages
    .flatMap((message) => message.embeds ?? [])
    .map((embed) => embed.image?.url ?? embed.thumbnail?.url)
    .find(Boolean);
  if (embedImage) return embedImage;

  if (ref) return `https://opengraph.githubassets.com/pengu/${ref.owner}/${ref.repo}`;
  return repo?.owner?.avatar_url;
}

function cleanDescription(content) {
  if (!content) return "";
  return content
    .replace(/https?:\/\/[^\s<>)"']+/gi, "")
    .replace(/[#*_>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDownloadAttachment(attachment) {
  const filename = attachment.filename?.toLowerCase() ?? "";
  return Boolean(attachment.url)
    && (filename.endsWith(".zip") || filename.endsWith(".js") || filename.endsWith(".css") || filename.endsWith(".json"));
}

function highestReactionCount(messages) {
  return messages.reduce((highest, message) => {
    const messageHighest = (message.reactions ?? []).reduce(
      (max, reaction) => Math.max(max, Number(reaction.count) || 0),
      0,
    );
    return Math.max(highest, messageHighest);
  }, 0);
}

function dedupeById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function snowflakeToIso(id) {
  const discordEpoch = 1420070400000n;
  const timestamp = (BigInt(id) >> 22n) + discordEpoch;
  return new Date(Number(timestamp)).toISOString();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
