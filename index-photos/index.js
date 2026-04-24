const { S3Client, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { RekognitionClient, DetectLabelsCommand } = require("@aws-sdk/client-rekognition");
const { Client } = require("@opensearch-project/opensearch");

const s3 = new S3Client({ region: "us-east-1" });
const rekognition = new RekognitionClient({ region: "us-east-1" });

const osClient = new Client({
  node: process.env.OPENSEARCH_ENDPOINT,
  auth: {
    username: process.env.OPENSEARCH_USERNAME,
    password: process.env.OPENSEARCH_PASSWORD,
  },
});

exports.handler = async (event) => {
  try {
    const record = event.Records[0];
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
    const createdTimestamp = record.eventTime;

    // 1) Rekognition labels
    const rekRes = await rekognition.send(
      new DetectLabelsCommand({
        Image: {
          S3Object: {
            Bucket: bucket,
            Name: key,
          },
        },
        MaxLabels: 10,
        MinConfidence: 70,
      })
    );

    const rekLabels = (rekRes.Labels || [])
      .map(l => l.Name?.toLowerCase().trim())
      .filter(Boolean);

    // 2) S3 metadata -> custom labels
    const headRes = await s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );

    const rawCustom = headRes.Metadata?.customlabels || "";
    const customLabels = rawCustom
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    // 3) merge + dedupe
    const labels = [...new Set([...rekLabels, ...customLabels])];

    const doc = {
      objectKey: key,
      bucket,
      createdTimestamp,
      labels,
    };

    const indexRes = await osClient.index({
      index: "photos",
      id: `${bucket}/${key}`,
      body: doc,
      refresh: true,
    });

    console.log("Indexed document successfully:", JSON.stringify(indexRes, null, 2));
    console.log("Stored document:", JSON.stringify(doc, null, 2));

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "indexed", doc }),
    };
  } catch (err) {
    console.error("Indexing failed:", err);
    throw err;
  }
};