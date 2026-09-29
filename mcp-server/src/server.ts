import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
    createMcpHandler,
    McpServer
} from "@modelcontextprotocol/server";

import * as z from "zod/v4";

import {
    BedrockRuntimeClient,
    InvokeModelCommand
} from "@aws-sdk/client-bedrock-runtime";

import {
    S3VectorsClient,
    QueryVectorsCommand
} from "@aws-sdk/client-s3vectors";

import {
    DynamoDBClient
} from "@aws-sdk/client-dynamodb";

import {
    DynamoDBDocumentClient,
    ScanCommand
} from "@aws-sdk/lib-dynamodb";


/* -------------------------------------------------------
   CONFIGURATION
------------------------------------------------------- */

const AWS_REGION =
    process.env.AWS_REGION ?? "ap-southeast-2";

const GITHUB_OWNER =
    process.env.GITHUB_OWNER ?? "akashbiswas94";

const GITHUB_REPO =
    process.env.GITHUB_REPO ?? "cab432-repository-custodian-demo";

const VECTOR_BUCKET =
    process.env.VECTOR_BUCKET ?? "n12371661-repo-vectors";

const VECTOR_INDEX =
    process.env.VECTOR_INDEX ?? "repo-context";

const EMBEDDING_MODEL =
    process.env.EMBEDDING_MODEL ??
    "amazon.titan-embed-text-v2:0";

const ANALYSIS_TABLE =
    process.env.ANALYSIS_TABLE ??
    "n12371661-issue-analysis";

const PORT =
    Number(process.env.PORT ?? 3000);


/* -------------------------------------------------------
   AWS CLIENTS
------------------------------------------------------- */

const bedrock = new BedrockRuntimeClient({
    region: AWS_REGION
});

const s3vectors = new S3VectorsClient({
    region: AWS_REGION
});

const dynamodb = DynamoDBDocumentClient.from(
    new DynamoDBClient({
        region: AWS_REGION
    })
);


/* -------------------------------------------------------
   HELPER FUNCTIONS
------------------------------------------------------- */

function result(value: unknown) {

    const text =
        typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2);

    return {
        content: [
            {
                type: "text" as const,
                text
            }
        ]
    };
}


function errorResult(error: unknown) {

    const message =
        error instanceof Error
            ? error.message
            : String(error);

    return {
        isError: true,
        content: [
            {
                type: "text" as const,
                text: `Tool error: ${message}`
            }
        ]
    };
}


/* -------------------------------------------------------
   GITHUB
------------------------------------------------------- */

async function githubRequest(path: string) {

    const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent":
            "n12371661-cab432-repository-custodian",
        "X-GitHub-Api-Version": "2022-11-28"
    };

    /*
      A token is optional for a public repository.

      Later in the assignment we will retrieve any required
      GitHub credential from AWS Secrets Manager.
    */

    if (process.env.GITHUB_TOKEN) {
        headers.Authorization =
            `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const response = await fetch(
        `https://api.github.com${path}`,
        {
            headers
        }
    );

    if (!response.ok) {

        throw new Error(
            `GitHub API returned ${response.status} ${response.statusText}`
        );
    }

    return response.json();
}


/* -------------------------------------------------------
   BEDROCK EMBEDDINGS
------------------------------------------------------- */

async function createEmbedding(text: string) {

    const payload = {
        inputText: text,
        dimensions: 1024,
        normalize: true
    };

    const response = await bedrock.send(
        new InvokeModelCommand({
            modelId: EMBEDDING_MODEL,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(payload)
        })
    );

    const decoded =
        new TextDecoder().decode(response.body);

    const modelResponse =
        JSON.parse(decoded);

    const embedding =
        modelResponse.embedding as number[];

    if (!embedding || embedding.length !== 1024) {

        throw new Error(
            `Unexpected embedding dimension: ${embedding?.length}`
        );
    }

    return embedding;
}


/* -------------------------------------------------------
   VECTOR SEARCH
------------------------------------------------------- */

async function searchVectors(
    query: string,
    topK: number
) {

    const embedding =
        await createEmbedding(query);

    const response =
        await s3vectors.send(
            new QueryVectorsCommand({

                vectorBucketName:
                    VECTOR_BUCKET,

                indexName:
                    VECTOR_INDEX,

                queryVector: {
                    float32: embedding
                },

                topK,

                returnMetadata: true,

                returnDistance: true
            })
        );

    return {
        query,
        distanceMetric:
            response.distanceMetric,

        matches:
            response.vectors ?? []
    };
}


/* -------------------------------------------------------
   MCP SERVER FACTORY
------------------------------------------------------- */

function buildServer() {

    const server = new McpServer({

        name:
            "n12371661-repository-custodian-mcp",

        version:
            "1.0.0"
    });


    /* ---------------------------------------------------
       TOOL 1 — REPOSITORY INFO
    --------------------------------------------------- */

    server.registerTool(

        "get_repository_info",

        {
            description:
                "Returns basic information about the GitHub repository managed by the Repository Custodian.",

            inputSchema:
                z.object({})
        },

        async () => {

            try {

                const repo =
                    await githubRequest(
                        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`
                    ) as any;

                return result({

                    name:
                        repo.name,

                    fullName:
                        repo.full_name,

                    description:
                        repo.description,

                    defaultBranch:
                        repo.default_branch,

                    openIssues:
                        repo.open_issues_count,

                    repositoryUrl:
                        repo.html_url,

                    lastUpdated:
                        repo.updated_at
                });

            } catch (error) {

                return errorResult(error);
            }
        }
    );


    /* ---------------------------------------------------
       TOOL 2 — LIST OPEN ISSUES
    --------------------------------------------------- */

    server.registerTool(

        "list_open_issues",

        {
            description:
                "Lists open GitHub issues in the repository.",

            inputSchema:
                z.object({

                    limit:
                        z.number()
                            .int()
                            .min(1)
                            .max(50)
                            .default(10)
                })
        },

        async ({ limit }) => {

            try {

                const response =
                    await githubRequest(

                        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
                        `/issues?state=open&per_page=${limit}`

                    ) as any[];

                /*
                  GitHub's issues endpoint also includes
                  pull requests, so remove those.
                */

                const issues =
                    response
                        .filter(issue =>
                            !issue.pull_request
                        )
                        .map(issue => ({

                            number:
                                issue.number,

                            title:
                                issue.title,

                            state:
                                issue.state,

                            url:
                                issue.html_url,

                            createdAt:
                                issue.created_at,

                            updatedAt:
                                issue.updated_at,

                            labels:
                                issue.labels?.map(
                                    (label: any) =>
                                        label.name
                                ) ?? []
                        }));

                return result({
                    repository:
                        `${GITHUB_OWNER}/${GITHUB_REPO}`,

                    count:
                        issues.length,

                    issues
                });

            } catch (error) {

                return errorResult(error);
            }
        }
    );


    /* ---------------------------------------------------
       TOOL 3 — GET ISSUE
    --------------------------------------------------- */

    server.registerTool(

        "get_issue",

        {
            description:
                "Retrieves full information about one GitHub issue.",

            inputSchema:
                z.object({

                    issueNumber:
                        z.number()
                            .int()
                            .positive()
                })
        },

        async ({ issueNumber }) => {

            try {

                const issue =
                    await githubRequest(

                        `/repos/${GITHUB_OWNER}/${GITHUB_REPO}` +
                        `/issues/${issueNumber}`

                    ) as any;

                return result({

                    number:
                        issue.number,

                    title:
                        issue.title,

                    state:
                        issue.state,

                    body:
                        issue.body,

                    labels:
                        issue.labels?.map(
                            (label: any) =>
                                label.name
                        ) ?? [],

                    createdAt:
                        issue.created_at,

                    updatedAt:
                        issue.updated_at,

                    url:
                        issue.html_url
                });

            } catch (error) {

                return errorResult(error);
            }
        }
    );


    /* ---------------------------------------------------
       TOOL 4 — VECTOR SEARCH
    --------------------------------------------------- */

    server.registerTool(

        "search_repository_context",

        {
            description:
                "Semantically searches repository documentation and issues using Amazon Titan embeddings and Amazon S3 Vectors.",

            inputSchema:
                z.object({

                    query:
                        z.string()
                            .min(2),

                    topK:
                        z.number()
                            .int()
                            .min(1)
                            .max(10)
                            .default(3)
                })
        },

        async ({ query, topK }) => {

            try {

                const matches =
                    await searchVectors(
                        query,
                        topK
                    );

                return result(matches);

            } catch (error) {

                return errorResult(error);
            }
        }
    );


    /* ---------------------------------------------------
       TOOL 5 — RECENT ISSUE ANALYSIS
    --------------------------------------------------- */

    server.registerTool(

        "get_recent_analysis",

        {
            description:
                "Returns recent issue-analysis records stored in DynamoDB.",

            inputSchema:
                z.object({

                    limit:
                        z.number()
                            .int()
                            .min(1)
                            .max(20)
                            .default(5)
                })
        },

        async ({ limit }) => {

            try {

                const response =
                    await dynamodb.send(
                        new ScanCommand({

                            TableName:
                                ANALYSIS_TABLE,

                            Limit:
                                50
                        })
                    );

                const items =
                    response.Items ?? [];

                items.sort(
                    (a: any, b: any) =>
                        String(
                            b.processedAt ?? ""
                        ).localeCompare(
                            String(
                                a.processedAt ?? ""
                            )
                        )
                );

                return result({

                    count:
                        Math.min(
                            limit,
                            items.length
                        ),

                    items:
                        items.slice(
                            0,
                            limit
                        )
                });

            } catch (error) {

                return errorResult(error);
            }
        }
    );


    return server;
}


/* -------------------------------------------------------
   MCP HTTP ENDPOINT
------------------------------------------------------- */

const handler =
    createMcpHandler(buildServer);

const nodeHandler =
    toNodeHandler(handler);

const app =
    createMcpExpressApp();


/* -------------------------------------------------------
   HEALTH ENDPOINT
------------------------------------------------------- */

app.get(
    "/health",
    (_req, res) => {

        res.json({

            status: "ok",

            service:
                "n12371661-repository-custodian-mcp",

            region:
                AWS_REGION,

            vectorBucket:
                VECTOR_BUCKET,

            vectorIndex:
                VECTOR_INDEX
        });
    }
);


/* -----------------------MCP ENDPOINT ---------------------------------- */

app.all(
    "/mcp",
    (req, res) => {

        void nodeHandler(
            req,
            res,
            req.body
        );
    }
);


/* ----------------------- START SERVER ------------------- */

app.listen(
    PORT,
    "127.0.0.1",
    () => {

        console.log(
            `MCP server running: http://127.0.0.1:${PORT}/mcp`
        );

        console.log(
            `Health check: http://127.0.0.1:${PORT}/health`
        );
    }
);