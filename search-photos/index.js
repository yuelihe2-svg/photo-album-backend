const { Client } = require("@opensearch-project/opensearch");
const {
  LexRuntimeV2Client,
  RecognizeTextCommand,
} = require("@aws-sdk/client-lex-runtime-v2");

const REGION = process.env.AWS_REGION || "us-east-1";

const osClient = new Client({
  node: process.env.OPENSEARCH_ENDPOINT,
  auth: {
    username: process.env.OPENSEARCH_USERNAME,
    password: process.env.OPENSEARCH_PASSWORD,
  },
});

const lexClient = new LexRuntimeV2Client({
  region: REGION,
});

const STOPWORDS = new Set([
  "show",
  "me",
  "photo",
  "photos",
  "picture",
  "pictures",
  "image",
  "images",
  "with",
  "and",
  "in",
  "of",
  "the",
  "a",
  "an",
  "please",
  "find",
  "for",
  "to",
  "my",
  "album",
  "look",
  "search",
  "get",
]);

const SINGULAR_MAP = {
  cats: "cat",
  dogs: "dog",
  trees: "tree",
  birds: "bird",
  puppies: "puppy",
  kitties: "kitty",
};

function buildResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "OPTIONS,GET",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function encodeS3Key(key) {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function singularizeWord(word) {
  if (!word) return word;

  if (SINGULAR_MAP[word]) {
    return SINGULAR_MAP[word];
  }

  // 保留自定义 label 里的横线/下划线，不做激进处理
  if (!/^[a-z0-9_-]+$/.test(word)) {
    return word;
  }

  // 只对纯字母词做轻量复数归一化
  if (!/^[a-z]+$/.test(word)) {
    return word;
  }

  if (word.endsWith("ies") && word.length > 3) {
    return word.slice(0, -3) + "y";
  }

  if (
    (word.endsWith("ches") ||
      word.endsWith("shes") ||
      word.endsWith("xes") ||
      word.endsWith("zes") ||
      word.endsWith("ses")) &&
    word.length > 4
  ) {
    return word.slice(0, -2);
  }

  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3) {
    return word.slice(0, -1);
  }

  return word;
}

function normalizeKeywords(text) {
  if (!text) return [];

  const words = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !STOPWORDS.has(word))
    .map((word) => singularizeWord(word));

  // 去重并保持顺序
  return [...new Set(words)];
}

async function extractSearchTermsFromLex(userText) {
  // 如果没配 Lex 环境变量，就直接回退到原始输入
  if (!process.env.LEX_BOT_ID || !process.env.LEX_BOT_ALIAS_ID) {
    return {
      intentName: "NoLexConfigured",
      searchTerms: userText,
    };
  }

  try {
    const command = new RecognizeTextCommand({
      botId: process.env.LEX_BOT_ID,
      botAliasId: process.env.LEX_BOT_ALIAS_ID,
      localeId: process.env.LEX_LOCALE_ID || "en_US",
      sessionId: `search-${Date.now()}`,
      text: userText,
    });

    const response = await lexClient.send(command);
    console.log("Lex response:", JSON.stringify(response, null, 2));

    const intentName = response.sessionState?.intent?.name || "";
    const slots = response.sessionState?.intent?.slots || {};

    const searchTerms =
      slots.SearchTerms?.value?.interpretedValue ||
      slots.SearchTerms?.value?.originalValue ||
      userText;

    return {
      intentName,
      searchTerms,
    };
  } catch (error) {
    console.warn("Lex call failed, falling back to raw query:", error.message);
    return {
      intentName: "LexErrorFallback",
      searchTerms: userText,
    };
  }
}

exports.handler = async (event) => {
  try {
    console.log("Received event:", JSON.stringify(event, null, 2));

    const rawQuery =
      event?.queryStringParameters?.q ||
      event?.queryStringParameters?.query ||
      "";

    if (!rawQuery.trim()) {
      return buildResponse(200, { results: [] });
    }

    const { intentName, searchTerms } = await extractSearchTermsFromLex(
      rawQuery.trim()
    );

    console.log("Recognized intent:", intentName);
    console.log("Extracted search terms:", searchTerms);

    const keywords = normalizeKeywords(searchTerms);
    console.log("Normalized keywords:", keywords);

    if (!keywords.length) {
      return buildResponse(200, { results: [] });
    }

    const shouldQueries = keywords.map((keyword) => ({
      match: {
        labels: keyword,
      },
    }));

    const searchResponse = await osClient.search({
      index: "photos",
      body: {
        size: 50,
        query: {
          bool: {
            should: shouldQueries,
            minimum_should_match: 1,
          },
        },
      },
    });

    const hits = searchResponse.body?.hits?.hits || searchResponse.hits?.hits || [];

    // 去重，避免同一张图片因多个关键词命中而重复出现
    const seen = new Set();
    const results = [];

    for (const hit of hits) {
      const source = hit._source || {};
      const uniqueKey = `${source.bucket || ""}/${source.objectKey || ""}`;

      if (seen.has(uniqueKey)) {
        continue;
      }
      seen.add(uniqueKey);

      results.push({
        objectKey: source.objectKey,
        bucket: source.bucket,
        createdTimestamp: source.createdTimestamp,
        labels: source.labels || [],
        url: `https://${source.bucket}.s3.amazonaws.com/${encodeS3Key(
          source.objectKey
        )}`,
      });
    }

    console.log("Search results:", JSON.stringify(results, null, 2));

    return buildResponse(200, { results });
  } catch (error) {
    console.error("Search error:", error);

    return buildResponse(500, {
      error: "Search failed",
      message: error.message,
    });
  }
};