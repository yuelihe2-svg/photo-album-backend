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
//test
function encodeS3Key(key) {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function extractSearchTermsFromLex(userText) {
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

    const keywords = searchTerms
      .toLowerCase()
      .split(/[,\s]+/)
      .map((word) => word.trim())
      .filter(Boolean);

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

    const hits =
      searchResponse.body?.hits?.hits ||
      searchResponse.hits?.hits ||
      [];

    const results = hits.map((hit) => {
      const source = hit._source || {};
      return {
        objectKey: source.objectKey,
        bucket: source.bucket,
        createdTimestamp: source.createdTimestamp,
        labels: source.labels || [],
        url: `https://${source.bucket}.s3.amazonaws.com/${encodeS3Key(
          source.objectKey
        )}`,
      };
    });

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