[dynatrace@DCPDYNAAP01 Dynatrace_problem_exporter]$ cat Production-V2.js
process.env.HTTP_PROXY = '';
process.env.HTTPS_PROXY = '';
process.env.http_proxy = '';
process.env.https_proxy = '';
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const https = require("https");
const { Parser } = require("json2csv");
const ExcelJS = require("exceljs");
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.static(__dirname));
const {
    DYNATRACE_URL,
    DYNATRACE_API_TOKEN
} = process.env;

if (!DYNATRACE_URL || !DYNATRACE_API_TOKEN) {
    console.error("Missing DYNATRACE_URL or DYNATRACE_API_TOKEN");
    process.exit(1);
}
const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});
const dtClient = axios.create({
    baseURL: DYNATRACE_URL,
    httpsAgent,
    proxy: false,
    timeout: 60000,
    headers: {
        Authorization: `Api-Token ${DYNATRACE_API_TOKEN}`,
        "Content-Type": "application/json"
    }
});
// =====================================================
// Export Configuration
// ProdServer V2
// =====================================================

// Export only these Management Zones.
// Replace these names with your actual 21 Management Zones.

const ALLOWED_MANAGEMENT_ZONES = [

    "ATM",

    "ECOM",

    "EKYC",

    "FI/MATM",

    "IMPS Switch",

    "UPI Switch",

    "NACH",

    "DISA",

    "ADV",

    "Internet Banking",

    "Mobile Banking",

    "LOS",

    "EMANDATE DEIT",

    "PREVALIDATION",

    "Miscall",

    "WhatsApp Banking",

    "PFMS",

    "CBS Java Frontend",

    "Micro ATM",

    "CBSAPI",

    "Account Aggregator"

];

//------------------------------------------------------
// Export Settings
//------------------------------------------------------

const EXPORT_CONFIG = {

    PAGE_SIZE: 500,

    RETRY_COUNT: 3,

    RETRY_DELAY: 2000,

    EXCEL_DATE_FORMAT: "dd-mmm-yyyy hh:mm:ss",

    MAX_SHEETNAME: 31

};

//------------------------------------------------------
// Process Group Cache
//------------------------------------------------------

const processGroupCache = new Map();

//------------------------------------------------------
// Entity Cache
//------------------------------------------------------

const entityCache = new Map();

//------------------------------------------------------
// Host Cache
//------------------------------------------------------

const hostCache = new Map();

// =====================================================
// Helper Function #1
// Build request parameters
// =====================================================
function buildProblemParams(req) {
    const params = {};
    if (req.query.timeFrom)
        params.from = req.query.timeFrom;
    if (req.query.timeTo)
        params.to = req.query.timeTo;
    if (req.query.gf)
        params.gf = req.query.gf;
    params.pageSize = EXPORT_CONFIG.PAGE_SIZE;
    return params;
}
// =====================================================
// Helper Function #2
// Fetch all Security Problems (Pagination)
// =====================================================
async function getAllSecurityProblems(req) {
    let problems = [];
    let nextPageKey = null;
    do {
        let response;
        if (nextPageKey) {
            console.log("Loading next page...");
            response = await dtClient.get(
                "/api/v2/securityProblems",
                {
                    params: {
                        nextPageKey
                    }
                }
            );
        }
        else {
            console.log("Loading first page...");
            response = await dtClient.get(
                "/api/v2/securityProblems",
                {
                    params: buildProblemParams(req)
                }
            );
        }
        if (response.data.securityProblems) {
            problems.push(...response.data.securityProblems);
            console.log(`Collected : ${problems.length}`);
        }
        nextPageKey = response.data.nextPageKey;
    }
    while (nextPageKey);
    return problems;
}
// =====================================================
// Helper Function #3
// Fetch Security Problem Details
// =====================================================
async function getSecurityProblemDetails(id) {
    try {
        const response = await dtClient.get(
            `/api/v2/securityProblems/${id}`,
            {
                params: {
                    fields: "+riskAssessment,+managementZones,+globalCounts,+filteredCounts,+description,+remediationDescription,+events,+vulnerableComponents,+affectedEntities,+exposedEntities,+reachableDataAssets,+relatedEntities,+relatedContainerImages,+relatedAttacks,+entryPoints",
                    from:
                        "now-30d"
                }
            }
        );
        return response.data;
    }
    catch (err) {
        console.log("================================");
        console.log("Detail Failed :", id);
        console.log("Status :", err.response?.status);
        console.log("Data :", JSON.stringify(err.response?.data));
        console.log("Message :", err.message);
        console.log("================================");
        return {};
    }
}
// =====================================================
// Helper Function #4
// Fetch Vulnerable Functions
// =====================================================
async function getVulnerableFunctions(id) {
    try {
        const response = await dtClient.get(
            `/api/v2/securityProblems/${id}/vulnerableFunctions`,
            {
                params: {
                        from: "now-30d",
                        to: "now"
                    }
            }
        );
        return response.data;
    }
    catch (err) {
        console.log("================================");
        console.log("VF Failed :", id);
        console.log("Status :", err.response?.status);
        console.log("Data :", JSON.stringify(err.response?.data));
        console.log("Message :", err.message);
        console.log("================================");
        return {};
    }
}

 // =====================================================
// Helper Function #5
// Collect Process Groups
// =====================================================
function collectProcessGroups(vulnerableFunctions) {
    let ids = [];
    if (!vulnerableFunctions.vulnerableFunctions)
        return ids;
    vulnerableFunctions.vulnerableFunctions.forEach(v => {
        ids.push(...(v.processGroupsInUse || []));
        ids.push(...(v.processGroupsNotInUse || []));
        ids.push(...(v.processGroupsNotAvailable || []));
    });
    return [...new Set(ids)];
}
// =====================================================
// Helper Function #6
// Resolve Process Groups (V2)
// =====================================================

async function resolveProcessGroups(processGroupIds) {

    if (!processGroupIds || processGroupIds.length === 0)
        return [];

    const result = [];

    const idsToLookup = [];

    //--------------------------------------------------
    // Check Cache
    //--------------------------------------------------

    for (const id of processGroupIds) {

        if (processGroupCache.has(id)) {

            result.push(processGroupCache.get(id));

        }
        else {

            idsToLookup.push(id);

        }

    }

    //--------------------------------------------------
    // Lookup Remaining IDs
    //--------------------------------------------------

    if (idsToLookup.length > 0) {

        try {

            const selector =
                idsToLookup
                    .map(id => `"${id}"`)
                    .join(",");

            const response =
                await dtClient.get(

                    "/api/v2/entities",

                    {

                        params: {

                            pageSize: idsToLookup.length,

                            entitySelector: `entityId(${selector})`

                        }

                    }

                );

            const entities =
                response.data.entities || [];

            entities.forEach(entity => {

                processGroupCache.set(
                    entity.entityId,
                    entity
                );

                result.push(entity);

            });

        }

        catch (err) {

            console.log("================================");
            console.log("Process Group Lookup Failed");
            console.log(err.message);
            console.log("================================");

        }

    }

    //--------------------------------------------------
    // Remove Duplicate Process Groups
    //--------------------------------------------------

    return result.filter(

        (item, index, self) =>

            index ===

            self.findIndex(

                x => x.entityId === item.entityId

            )

    );

}

// =====================================================
// Helper Function
// Resolve Hosts for Process Groups
// PROCESS_GROUP_INSTANCE --[runsOn]--> HOST
// =====================================================

async function resolveHostsForProcessGroups(processGroups) {

    if (!processGroups || processGroups.length === 0)
        return new Map();

    const pgToHostIds = new Map();
    const allHostIds = new Set();

    processGroups.forEach(pg => {
        const runsOn = pg.toRelationships?.runsOn || [];
        const hostIds = runsOn
            .map(h => h.id)
            .filter(id => id && id.startsWith("HOST-"));
        pgToHostIds.set(pg.entityId, hostIds);
        hostIds.forEach(id => allHostIds.add(id));
    });

    const idsToLookup = [...allHostIds].filter(id => !hostCache.has(id));

    if (idsToLookup.length > 0) {
        try {
            const selector = idsToLookup.map(id => `"${id}"`).join(",");
            const response = await dtClient.get(
                "/api/v2/entities",
                {
                    params: {
                        entitySelector: `entityId(${selector})`,
                        pageSize: idsToLookup.length
                    }
                }
            );
            const entities = response.data.entities || [];
            entities.forEach(entity => {
                hostCache.set(entity.entityId, entity);
            });
        }
        catch (err) {
            console.log("================================");
            console.log("Host Lookup Failed");
            console.log(err.message);
            console.log("================================");
        }
    }

    const pgToHostNames = new Map();
    for (const [pgId, hostIds] of pgToHostIds.entries()) {
        const names = hostIds.map(id => hostCache.get(id)?.displayName || id);
        pgToHostNames.set(pgId, names);
    }

    return pgToHostNames;
}

// =====================================================
// Helper Function
// Format Process Groups
// =====================================================

function formatProcessGroups(processGroups) {

    if (!processGroups || processGroups.length === 0)
        return "N/A";

    return processGroups

        .map(pg =>

            pg.displayName ||

            pg.name ||

            pg.entityId ||

            "Unknown"

        )

        .join("\n");

}

// =====================================================
// Helper Function
// Format Hosts (from Process Group -> Host map)
// =====================================================

function formatHosts(processGroups, pgToHostNames) {

    if (!processGroups || processGroups.length === 0)
        return "N/A";

    const names = new Set();

    processGroups.forEach(pg => {
        const hostNames = pgToHostNames.get(pg.entityId) || [];
        hostNames.forEach(n => names.add(n));
    });

    return [...names].join("\n");
}

// =====================================================
// Helper Function
// Resolve Entity Names
// =====================================================

async function resolveEntities(entityIds) {

    if (!entityIds || entityIds.length === 0)
        return [];

    const result = [];

    const idsToLookup = [];

    //--------------------------------------------------
    // Check Cache
    //--------------------------------------------------

    for (const id of entityIds) {

        if (!id)
            continue;

        if (entityCache.has(id)) {

            result.push(entityCache.get(id));

        }
        else {

            idsToLookup.push(id);

        }

    }

    //--------------------------------------------------
    // Lookup Missing IDs
    //--------------------------------------------------

    if (idsToLookup.length > 0) {

        try {

            const selector =
                idsToLookup
                    .map(id => `"${id}"`)
                    .join(",");

            const response =
                await dtClient.get(
                    "/api/v2/entities",
                    {
                        params: {
                            entitySelector: `entityId(${selector})`,
                            pageSize: idsToLookup.length,
                            fields: "toRelationships"
                        }
                    }
                );

            const entities =
                response.data.entities || [];

            entities.forEach(entity => {

                entityCache.set(
                    entity.entityId,
                    entity
                );

                result.push(entity);

            });

        }

        catch (err) {

            console.log("Entity Resolver Failed");

        }

    }

    return result;

}

// =====================================================
// Helper Function #7
// Fetch Security Problem Events
// =====================================================

async function getSecurityProblemEvents(id) {

    try {

        const response = await dtClient.get(

            `/api/v2/securityProblems/${id}/events`,

            {

                params: {

                    from: "now-30d",

                    to: "now"

                }

            }

        );

        return response.data.events || [];

    }

    catch (err) {

        console.log("================================");

        console.log("EVENT API Failed :", id);

        console.log("Status :", err.response?.status);

        console.log("Message :", err.message);

        console.log("================================");

        return [];

    }

}
 // =====================================================
// Helper Function #8
// Fetch Remediation Items
// =====================================================

async function getRemediationItems(id) {

    try {

        const response = await dtClient.get(

            `/api/v2/securityProblems/${id}/remediationItems`

        );

        return response.data.remediationItems || [];

    }

    catch (err) {

        console.log("================================");

        console.log("REMEDIATION API Failed :", id);

        console.log("Status :", err.response?.status);

        console.log("Message :", err.message);

        console.log("================================");

        return [];

    }

}

// =====================================================
// Endpoint : Normal Problems
// =====================================================
app.get("/api/problems", async (req, res) => {
    try {
        console.log("Fetching Problems...");
        const response = await dtClient.get(
            "/api/v2/problems",
            {
                params: buildProblemParams(req)
            }
        );
        res.json(response.data);
    }
    catch (err) {
        console.log("================================");
        console.log("Problems Failed");
        console.log("Status :", err.response?.status);
        console.log("Data :", JSON.stringify(err.response?.data));
        console.log("Message :", err.message);
        console.log("================================");
        res.status(500).json({
            error: "Unable to fetch Problems"
        });
    }
});
// =====================================================
// Export Problems as CSV
// =====================================================
app.get("/api/problems/csv", async (req, res) => {
    try {
        console.log("Generating Problems CSV...");
        const response = await dtClient.get(
            "/api/v2/problems",
            {
                params: buildProblemParams(req)
            }
        );
        const problems = response.data.problems || [];
        const rows = problems.map(p => ({
            ProblemID: p.problemId,
            DisplayID: p.displayId,
            Title: p.title,
            Severity: p.severityLevel,
            Status: p.status,
            Impact: p.impactLevel,
            StartTime: p.startTime,
            EndTime: p.endTime
        }));
        const parser = new Parser();
        const csv = parser.parse(rows);
        res.header("Content-Type", "text/csv");
        console.log("CSV Created Successfully.");
        res.attachment("dynatrace_problems.csv");
        res.send(csv);
        console.log("CSV sent to Browser.");
    }
    catch (err) {
        console.log(err.response?.data || err.message);
        res.status(500).json({
            error: "Unable to generate Problems CSV"
        });
    }
});

// =====================================================
// Security Problems Endpoint
// =====================================================
app.get("/api/security-problems", async (req, res) => {
    try {
        console.log("Loading Security Problems...");
        const allProblems = await getAllSecurityProblems(req);
        console.log(`Problems Found : ${allProblems.length}`);
        const finalData = [];
        const csvData = [];
        for (const problem of allProblems) {
            const id = problem.securityProblemId;
            console.log(`Processing : ${id}`);
            // -----------------------------
            // Fetch Problem Details
            // -----------------------------
            const detail =
                await getSecurityProblemDetails(id);
            // -----------------------------
            // Fetch Vulnerable Functions
            // -----------------------------
            const vulnerableFunctions =
                await getVulnerableFunctions(id);
            // -----------------------------
            // Collect Process Groups
            // -----------------------------
            const processGroupIds =
                collectProcessGroups(vulnerableFunctions);
            console.log("ProcessGroupIDs:");
            console.log(JSON.stringify(processGroupIds, null, 2));
            // -----------------------------
            // Resolve Process Groups
            // -----------------------------
            const processGroups =
                await resolveProcessGroups(processGroupIds);
            const pgToHostNames =
                await resolveHostsForProcessGroups(processGroups);
            const hosts =
                formatHosts(processGroups, pgToHostNames);
            // -----------------------------
            // Final Object
            // -----------------------------
            finalData.push({
                summary: problem,
                detail,
                vulnerableFunctions,
                processGroups,
                hosts 
            });
        }
        console.log("Export Completed.");
        res.json({
            generatedAt: new Date(),
            totalProblems: finalData.length,
            securityProblems: finalData
        });
    }
    catch (err) {
        console.log("================================");
        console.log("Exporter Failed");
        console.log("Status :", err.response?.status);
        console.log("Data :", JSON.stringify(err.response?.data));
        console.log("Message :", err.message);
        console.log("================================");
        res.status(500).json({
            error: err.response?.data || err.message
        });
    }
});
 // =====================================================
// Export Problems as Excel
// =====================================================
app.get("/api/problems/excel", async (req, res) => {
    try {
        console.log("Generating Problems Excel...");
        const response = await dtClient.get(
            "/api/v2/problems",
            {
                params: buildProblemParams(req)
            }
        );
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Problems");
        worksheet.columns = [
            { header: "Problem ID", key: "problemId", width: 35 },
            { header: "Display ID", key: "displayId", width: 20 },
            { header: "Title", key: "title", width: 60 },
            { header: "Severity", key: "severity", width: 20 },
            { header: "Status", key: "status", width: 15 },
            { header: "Impact", key: "impact", width: 20 },
            { header: "Start Time", key: "startTime", width: 25 },
            { header: "End Time", key: "endTime", width: 25 }
        ];
        // Make header bold
        worksheet.getRow(1).font = { bold: true };
        const problems = response.data.problems || [];
        problems.forEach(p => {
            worksheet.addRow({
                problemId: p.problemId,
                displayId: p.displayId,
                title: p.title,
                severity: p.severityLevel,
                status: p.status,
                impact: p.impactLevel,
                startTime: p.startTime,
                endTime: p.endTime
            });
        });
        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader(
            "Content-Disposition",
            'attachment; filename="dynatrace_problems.xlsx"'
        );
        await workbook.xlsx.write(res);
        res.end();
        console.log("Problems Excel Generated Successfully.");
    }
    catch (err) {
        console.log(err.response?.data || err.message);
        res.status(500).json({
            error: "Unable to generate Problems Excel"
        });
    }
});
// =====================================================
// Endpoint : Security Problems as EXCEL
// =====================================================
// =====================================================

// Export Security Problems as Excel
// One Worksheet Per Application
// PART-1
// =====================================================

app.get("/api/security-problems/excel", async (req, res) => {

    try {

        console.log("================================================");
        console.log("Generating Application-wise Security Report...");
        console.log("================================================");

        const allProblems = await getAllSecurityProblems(req);

        console.log(`Security Problems Found : ${allProblems.length}`);

        if (!allProblems || allProblems.length === 0) {

            return res.status(404).json({

                success: false,

                message: "No Security Problems Found"

            });

        }

        //-------------------------------------------------------
        // Workbook
        //-------------------------------------------------------

        const workbook = new ExcelJS.Workbook();

        workbook.creator = "Dynatrace Exporter";

        workbook.created = new Date();

        workbook.modified = new Date();

        //-------------------------------------------------------
        // All Vulnerabilities Worksheet
        //-------------------------------------------------------

        const dumpSheet = workbook.addWorksheet("Complete Dump");

        //-------------------------------------------------------
        // Summary Sheet
        //-------------------------------------------------------

        const summarySheet = workbook.addWorksheet("Summary");

        summarySheet.columns = [

            {
                header: "Application Name",
                key: "application",
                width: 35
            },

            {
                header: "Critical",
                key: "critical",
                width: 12
            },

            {
                header: "High",
                key: "high",
                width: 12
            },

            {
                header: "Medium",
                key: "medium",
                width: 12
            },

            {
                header: "Low",
                key: "low",
                width: 12
            },

            {
                header: "Total",
                key: "count",
                width: 12
            }

];

        summarySheet.getRow(1).font = {

            bold: true

        };

        summarySheet.views = [

            {
                state: "frozen",
                ySplit: 1
            }

        ];

        summarySheet.autoFilter = {

            from: "A1",

            to: "F1"

        };

        //-------------------------------------------------------
        // Complete Dump Worksheet Columns
        //-------------------------------------------------------

        dumpSheet.columns = [

        {
            header: "Application Name",
            key: "application",
            width: 30
        },

        {
            header: "Vulnerability ID",
            key: "displayId",
            width: 18
        },

        {
            header: "Vulnerability",
            key: "title",
            width: 50
        },

        {
            header: "Description",
            key: "description",
            width: 60
        },

        {
            header: "Severity",
            key: "severity",
            width: 15
        },

        {
            header: "CVSS Score",
            key: "cvss",
            width: 15
        },

        {
            header: "Affected Server / Component",
            key: "server",
            width: 35
        },

        {
            header: "Process Groups",
            key: "processGroups",
            width: 40
        },

        {
            header: "Host",
            key: "host",
            width: 35
        },

        {
            header: "Vulnerable Components",
            key: "components",
            width: 40
        },

        {
            header: "Reachable Data Assets",
            key: "dataAssets",
            width: 35
        },

        {
            header: "Related Entities",
            key: "relatedEntities",
            width: 40
        },

        {
            header: "CVE IDs",
            key: "cves",
            width: 30
        },

        {
            header: "Package",
            key: "packageName",
            width: 35
        },

        {
            header: "Technology",
            key: "technology",
            width: 20
        },

        {
            header: "Third Party",
            key: "thirdParty",
            width: 20
        },

        {
            header: "Code Level Vulnerability",
            key: "codeLevel",
            width: 25
        },

        {
            header: "Public Exploit",
            key: "publicExploit",
            width: 18
        },

        {
            header: "Exposure",
            key: "exposure",
            width: 18
        },

        {
            header: "Function Usage",
            key: "functionUsage",
            width: 20
        },

        {
            header: "Recommended Remediation",
            key: "remediation",
            width: 60
        },

        {
            header: "Current Status",
            key: "status",
            width: 15
        },

        {
            header: "First Seen",
            key: "firstSeen",
            width: 22
        },

        {
            header: "Last Updated",
            key: "lastUpdated",
            width: 22
        }
];
 dumpSheet.getRow(1).font = {

    bold: true,
    color: {
        argb: "FFFFFF"
    }

};

dumpSheet.getRow(1).fill = {

    type: "pattern",
    pattern: "solid",
    fgColor: {
        argb: "1F4E78"
    }

};

dumpSheet.views = [

    {
        state: "frozen",
        ySplit: 1
    }

];

dumpSheet.columns.forEach(col => {

    col.alignment = {

        vertical: "top",
        wrapText: true

    };

});
//-------------------------------------------------------
        // Store Worksheets
        //-------------------------------------------------------

        const worksheets = {};

        const worksheetStats = {};

        //-------------------------------------------------------
        // Create Worksheet
        //-------------------------------------------------------

        function getWorksheet(applicationName) {

            let sheetName =
                (applicationName || "Unknown")
                    .replace(/[\\/*?:[\]]/g, "_")
                    .trim();

            if (!sheetName.length) {

                sheetName = "Unknown";

            }

            sheetName = sheetName.substring(0, 31);

            if (!worksheets[sheetName]) {

                const ws =
                    workbook.addWorksheet(sheetName);

                const worksheetColumns = [

                    {
                        header: "Application Name",
                        key: "application",
                        width: 30
                    },

                    {
                        header: "Vulnerability ID",
                        key: "displayId",
                        width: 18
                    },

                    {
                        header: "Vulnerability",
                        key: "title",
                        width: 50
                    },

                    {
                        header: "Description",
                        key: "description",
                        width: 60
                    },

                    {
                        header: "Severity",
                        key: "severity",
                        width: 15
                    },

                    {
                        header: "CVSS Score",
                        key: "cvss",
                        width: 15
                    },

                    {
                        header: "Affected Server / Component",
                        key: "server",
                        width: 35
                    },

                    {
                        header: "Process Groups",
                        key: "processGroups",
                        width: 40
                    },

                    {
                        header: "Vulnerable Components",
                        key: "components",
                        width: 40
                    },

                    {
                        header: "Reachable Data Assets",
                        key: "dataAssets",
                        width: 35
                    },

                    {
                        header: "Related Entities",
                        key: "relatedEntities",
                        width: 40
                    },

                    {
                        header: "CVE IDs",
                        key: "cves",
                        width: 30
                    },

                    {
                        header: "Package",
                        key: "packageName",
                        width: 35
                    },

                    {
                        header: "Technology",
                        key: "technology",
                        width: 20
                    },

                    {
                        header: "Vulnerability Type",
                        key: "VulnerabilityType",
                        width: 30
                    },

                    {
                        header: "Public Exploit",
                        key: "publicExploit",
                        width: 18
                    },

                    {
                        header: "Exposure",
                        key: "exposure",
                        width: 18
                    },

                    {
                        header: "Function Usage",
                        key: "functionUsage",
                        width: 20
                    },

                    {
                        header: "Recommended Remediation",
                        key: "remediation",
                        width: 60
                    },

                    {
                        header: "Current Status",
                        key: "status",
                        width: 15
                    },

                    {
                        header: "First Seen",
                        key: "firstSeen",
                        width: 22
                    },

                    {
                        header: "Last Updated",
                        key: "lastUpdated",
                        width: 22
                    }

                ];

                ws.columns = worksheetColumns;

                dumpSheet.columns = worksheetColumns;
 //-------------------------------------------------------
// Format All Vulnerabilities Sheet
//-------------------------------------------------------

dumpSheet.views = [
    {
        state: "frozen",
        ySplit: 1
    }
];

dumpSheet.autoFilter = {
    from: "A1",
    to: "X1"
};

dumpSheet.columns.forEach(col => {
    col.alignment = {
        vertical: "top",
        wrapText: true
    };
});

dumpSheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: {
        argb: "1F4E78"
    }
};

dumpSheet.getRow(1).font = {
    bold: true,
    color: {
        argb: "FFFFFF"
    }
};


                ws.getRow(1).font = {

                    bold: true

                };

                ws.views = [

                    {
                        state: "frozen",
                        ySplit: 1
                    }

                ];

                ws.autoFilter = {

                    from: "A1",

                    to: "V1"

                };

                ws.columns.forEach(col => {

                    col.alignment = {

                        vertical: "top",

                        wrapText: true

                    };

                });

                ws.getRow(1).fill = {

                    type: "pattern",
                    pattern: "solid",
                    fgColor: {
                        argb: "1F4E78"

                    }

                };

                ws.getRow(1).font = {

                    bold: true,
                    color: {
                        argb: "FFFFFF"
                    }

                };

                worksheets[sheetName] = ws;

                worksheetStats[sheetName] = {

                    total: 0,
                    CRITICAL: 0,
                    HIGH: 0,
                    MEDIUM: 0,
                    LOW: 0

                };

            }

            return worksheets[sheetName];

        }

        //-------------------------------------------------------
        // Start Processing Security Problems
        //-------------------------------------------------------

        for (const problem of allProblems) {

            console.log(
                `Processing : ${problem.displayId || problem.securityProblemId}`
            );

            // PART-2 starts here
            //-------------------------------------------------------
            // Security Problem ID
            //-------------------------------------------------------

            const id = problem.securityProblemId;

            //-------------------------------------------------------
            // Get Security Problem Details
            //-------------------------------------------------------

            const detail =
                await getSecurityProblemDetails(id);

            //-------------------------------------------------------
            // Get Events
            //-------------------------------------------------------

            const events =
                await getSecurityProblemEvents(id);

            //-------------------------------------------------------
            // Get Remediation Items
            //-------------------------------------------------------

            const remediation =
                await getRemediationItems(id);

            //-------------------------------------------------------
            // Get Vulnerable Functions
            //-------------------------------------------------------

            const vulnerableFunctions =
                await getVulnerableFunctions(id);

            //-------------------------------------------------------
            // Resolve Process Groups
            //-------------------------------------------------------

            const processGroupIds =
                collectProcessGroups(vulnerableFunctions);

            const processGroups =
                await resolveProcessGroups(processGroupIds);
            const pgToHostNames =
                await resolveHostsForProcessGroups(processGroups);
            const hostNames =
                formatHosts(processGroups, pgToHostNames);

            //-------------------------------------------------------
            // Management Zones
            //-------------------------------------------------------

            const managementZones =
                Array.isArray(detail.managementZones)
                    ? detail.managementZones
                    : [];

            //-------------------------------------------------------
            // First Seen / Last Updated
            //-------------------------------------------------------

            const firstSeen =
                problem.firstSeenTimestamp
                    ? new Date(problem.firstSeenTimestamp)
                        .toLocaleString()
                    : "";

            const lastUpdated =
                problem.lastUpdatedTimestamp
                    ? new Date(problem.lastUpdatedTimestamp)
                        .toLocaleString()
                    : "";
            //-------------------------------------------------------
            // Affected Server / Component
            //-------------------------------------------------------

            let affectedServer = "";

            if (

                Array.isArray(detail.affectedEntities) &&
                detail.affectedEntities.length > 0
            ) {

                affectedServer =

                    detail.affectedEntities

                        .map(entity =>

                            entity.displayName ||

                            entity.name ||

                            entity.entityId ||

                            ""

                        )

                        .join("\n");

                }

else {


    affectedServer =
        formatProcessGroups(processGroups);

}

            //-------------------------------------------------------
            // Process Groups
            //-------------------------------------------------------

            const processGroupNames =
                formatProcessGroups(processGroups);

            //-------------------------------------------------------
            // Vulnerable Components
            //-------------------------------------------------------

            const vulnerableComponents =
                Array.isArray(detail.vulnerableComponents)
                    ? detail.vulnerableComponents
                        .map(x =>
                            x.displayName ||
                            x.name ||
                            x.id ||
                            ""
                        )
                        .join("\n")
                    : "";

            //-------------------------------------------------------
            // Reachable Data Assets
            //-------------------------------------------------------

            const reachableAssets =
                Array.isArray(detail.reachableDataAssets)
                    ? detail.reachableDataAssets
                        .map(x =>
                            x.displayName ||
                            x.name ||
                            x.id ||
                            ""
                        )
                        .join("\n")
                    : "";

            //-------------------------------------------------------
            // Related Entities
            //-------------------------------------------------------

            let relatedEntities = "";
            if (Array.isArray(detail.relatedEntities)) {

                relatedEntities = detail.relatedEntities

                    .map(entity =>

                        entity.displayName ||

                        entity.name ||

                        entity.entityId ||

                        entity.id ||

                        ""

                    )

                    .join("\n");

                }

            //-------------------------------------------------------
            // CVE IDs
            //-------------------------------------------------------

            const cveIds =
                Array.isArray(problem.cveIds)
                    ? problem.cveIds.join(",")
                    : "";

            //-------------------------------------------------------
            // Risk Assessment
            //-------------------------------------------------------

            const risk = detail.riskAssessment || {};

            //-------------------------------------------------------
            // Public Exploit
            //-------------------------------------------------------

            const publicExploit =
                risk.publicExploit || "";

            //-------------------------------------------------------
            // Exposure
            //-------------------------------------------------------

            const exposure =
                risk.exposure || "";

            //-------------------------------------------------------
            // Vulnerable Function Usage
            //-------------------------------------------------------

            const functionUsage =
                risk.vulnerableFunctionUsage || "";

            //-------------------------------------------------------
            // ThirdParty
            //-------------------------------------------------------

            const thirdParty =
                detail.thirdParty ??
                risk.thirdParty ??
                "";

            //-------------------------------------------------------
            // Code Level
            //-------------------------------------------------------

            const codeLevel =
                detail.codeLevelVulnerability ??
                risk.codeLevelVulnerability ??
                "";

            //-------------------------------------------------------
            // Common Row Data
            //-------------------------------------------------------

            const rowData = {

                displayId:
                    detail.displayId || "",

                title:
                    detail.title || "",

                description:
                    detail.description || "",

                severity:
                    detail.riskAssessment?.riskLevel || "",

                cvss:
                    detail.riskAssessment?.baseRiskScore || "",

                server:
                    affectedServer,

                processGroups:
                    processGroupNames,

                host:
                    hostNames,

                components:
                    vulnerableComponents,

                dataAssets:
                    reachableAssets,

                relatedEntities:
                    relatedEntities,

                cves:
                    cveIds,

                packageName:
                    detail.packageName ||
                    problem.packageName ||
                    "",

                technology:
                    detail.technology ||
                    problem.technology ||
                    "",

                vulnerabilityType:
                    problem.vulnerabilityType || "",

                publicExploit:
                    publicExploit,

                exposure:
                    exposure,

                functionUsage:
                    functionUsage,

                remediation:
                    detail.remediationDescription ||
                    (remediation.length > 0

                        ? remediation
                            .map(r =>
                                r.name ||
                                r.displayName ||
                                r.id
                            )
                            .join("\n")

                        : ""),

                status:
                    problem.status || "",

                firstSeen,

                lastUpdated

            };
 //-------------------------------------------------------
            // If no Management Zone found
            //-------------------------------------------------------

            if (managementZones.length === 0) {

                const ws =
                    getWorksheet("Unknown");

                ws.addRow({

                    application: "Unknown",

                    ...rowData

                });

                dumpSheet.addRow({
                    application: "Unknown",
                    ...rowData
                });

                const severity =
                    (rowData.severity || "").toUpperCase();

                worksheetStats["Unknown"].total++;

                if (worksheetStats["Unknown"][severity] !== undefined) {

                    worksheetStats["Unknown"][severity]++;

                }

            }

            //-------------------------------------------------------
            // One Worksheet per Application
            //-------------------------------------------------------

            else {

    //-------------------------------------------------------
    // Export only selected Management Zones
    //-------------------------------------------------------

    const selectedMZs = managementZones.filter(mz =>

        ALLOWED_MANAGEMENT_ZONES.some(

            zone =>

                zone.toLowerCase().trim() ===

                (mz.name || "").toLowerCase().trim()

        )

    );

//-------------------------------------------------------
    // Skip if Management Zone is not in allowed list
    //-------------------------------------------------------

    if (selectedMZs.length === 0) {

        console.log(
            `Skipping ${detail.displayId} - No allowed Management Zone found`
        );

        continue;

    }
 //-------------------------------------------------------
    // Create worksheet for selected Management Zones only
    //-------------------------------------------------------

    for (const mz of selectedMZs) {

        const appName = mz.name;

        const ws = getWorksheet(appName);

        ws.addRow({

            application: appName,

            ...rowData

        });

        dumpSheet.addRow({

            application: appName,

            ...rowData

        });

        const severity =
            (rowData.severity || "").toUpperCase();

        worksheetStats[appName].total++;

        if (worksheetStats[appName][severity] !== undefined) {

                worksheetStats[appName][severity]++;

        }

    }

}

            console.log(
                `Completed : ${detail.displayId || id}`
            );
        }

        //-------------------------------------------------------
        // Populate Summary Sheet
        //-------------------------------------------------------

        Object.keys(worksheetStats)
            .sort()
            .forEach(appName => {

                summarySheet.addRow({

                    application: appName,
                    critical: worksheetStats[appName].CRITICAL,
                    high: worksheetStats[appName].HIGH, 
                    medium: worksheetStats[appName].MEDIUM,
                    low: worksheetStats[appName].LOW,   
                    count: worksheetStats[appName].total

                });
});

let totalCritical = 0;
let totalHigh = 0;
let totalMedium = 0;
let totalLow = 0;
let grandTotal = 0;

Object.values(worksheetStats).forEach(stat => {

    totalCritical += stat.CRITICAL;
    totalHigh += stat.HIGH;
    totalMedium += stat.MEDIUM;
    totalLow += stat.LOW;
    grandTotal += stat.total;

});

summarySheet.addRow({});

summarySheet.addRow({

    application: "Grand Total",

    critical: totalCritical,

    high: totalHigh,

    medium: totalMedium,

    low: totalLow,

    count: grandTotal

});

 //-------------------------------------------------------
        // Make Summary Header Bold
        //-------------------------------------------------------

        summarySheet.getRow(1).font = {

            bold: true

        };

        //-------------------------------------------------------
        // Center Summary Columns
        //-------------------------------------------------------

        summarySheet.columns.forEach(col => {

            col.alignment = {

                vertical: "middle",

                horizontal: "center"

            };

        });

        //-------------------------------------------------------
        // Workbook Properties
        //-------------------------------------------------------

        workbook.calcProperties.fullCalcOnLoad = true;

        //-------------------------------------------------------
        // Response Header
        //-------------------------------------------------------

        const fileName =
            `Security_Problems_${new Date()
                .toISOString()
                .substring(0,10)}.xlsx`;

        res.setHeader(
            "Content-Type",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );

        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${fileName}"`
        );

        //-------------------------------------------------------
        // Write Workbook
        //-------------------------------------------------------

        await workbook.xlsx.write(res);

        res.end();

        console.log("========================================");
        console.log("Application-wise Excel Generated");
        console.log("Total Worksheets :", Object.keys(worksheets).length);
        console.log("========================================");

    }

    catch (err) {

        console.log("========================================");
        console.log("Excel Generation Failed");
        console.log("Message :", err.message);

        if (err.response) {

            console.log("Status :", err.response.status);

            console.log("Data :", JSON.stringify(err.response.data));

        }

        console.log("========================================");

        res.status(500).json({

            success: false,

            message: "Unable to generate Security Problems Excel.",

            error: err.message

        });

    }

});


// =====================================================
// Start Server
// =====================================================
app.listen(PORT, "10.49.19.198", () => {
    console.log("=====================================");
    console.log(" Dynatrace Exporter Started");
    console.log(` Listening : http://10.49.19.198:${PORT}`);
    console.log(" Problems  : /api/problems");
    console.log(" Security  : /api/security-problems");
    console.log("=====================================");
}); 
 
