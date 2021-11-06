import * as LSP from "vscode-languageserver/node";
import { BigQuery } from "@google-cloud/bigquery";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as bq2cst from "@dr666m1/bq2cst";
import * as prettier from "prettier";
import * as util from "./util";
import { CacheDB } from "./database";
import { reservedKeywords, globalFunctions } from "./keywords";
import { execSync } from "child_process";

type CompletionItem = {
  parent?: string;
  type?: string;
  name: string;
};

export type NameSpace = {
  start: { line: number; column: number };
  end: { line: number; column: number };
  variables: CompletionItem[];
};

type Configuration = {
  diagnostic: {
    dryRunOnSave: boolean;
    forVSCode: boolean;
  };
  formatting: Record<string, boolean>;
};

const defaultConfiguration: Configuration = {
  diagnostic: {
    dryRunOnSave: true,
    forVSCode: false,
  },
  formatting: {},
};

export class BQLanguageServer {
  public static async initialize(
    connection: LSP.Connection,
    db: CacheDB,
    params: LSP.InitializeParams
  ): Promise<BQLanguageServer> {
    return new BQLanguageServer(connection, db, params);
  }
  private bqClient = new BigQuery();
  public capabilities: LSP.InitializeResult = {
    capabilities: {
      textDocumentSync: LSP.TextDocumentSyncKind.Incremental,
      hoverProvider: true,
      documentFormattingProvider: true,
      completionProvider: {
        triggerCharacters: [".", "`"],
      },
    },
  };
  private configurations: Map<string, Thenable<Configuration>> = new Map();
  private defaultProject: string;
  private documents: LSP.TextDocuments<TextDocument> = new LSP.TextDocuments(
    TextDocument
  );
  private hasConfigurationCapability: boolean;
  private uriToCst: Record<string, bq2cst.UnknownNode[]> = {};
  private uriToText: Record<string, string> = {};
  private uriToTokens: Record<string, bq2cst.Token[]> = {};
  private constructor(
    private connection: LSP.Connection,
    private db: CacheDB,
    params: LSP.InitializeParams
  ) {
    const capabilities = params.capabilities;
    this.defaultProject = (
      execSync(" gcloud config get-value project") + ""
    ).trim();
    this.hasConfigurationCapability = !!(
      capabilities.workspace && capabilities.workspace.configuration
    );
  }
  private async dryRun(uri: LSP.URI): Promise<void> {
    let diagnostic: LSP.Diagnostic;
    try {
      let msg;
      const [_, apiResponse] = await this.bqClient.createQueryJob({
        query: this.uriToText[uri],
        dryRun: true,
      });
      if (
        apiResponse.statistics &&
        apiResponse.statistics.totalBytesProcessed
      ) {
        msg = util.formatBytes(
          Number(apiResponse.statistics.totalBytesProcessed)
        );
      } else {
        msg = "???B";
      }
      this.connection.sendDiagnostics({
        uri: uri,
        diagnostics: [],
      }); // clear old diagnostics
      this.connection.sendNotification("bq/totalBytesProcessed", {
        totalBytesProcessed: msg,
      });
    } catch (e: any) {
      const msg = e.message;
      const matchResult = msg.match(/\[([0-9]+):([0-9]+)\]/);
      if (matchResult) {
        // in the case of message like below
        // Syntax error: Unexpected end of script at [1:7]
        diagnostic = {
          severity: LSP.DiagnosticSeverity.Error,
          range: util.getTokenRangeByRowColumn(
            this.getDocInfo(uri),
            Number(matchResult[1]),
            Number(matchResult[2])
          ),
          message: msg,
        };
      } else {
        // in the case of message like below
        // Table name "abc" missing dataset while no default dataset is set in the request
        const splittedText = this.uriToText[uri].split("\n");
        diagnostic = {
          severity: LSP.DiagnosticSeverity.Error,
          range: {
            start: { line: 0, character: 0 },
            end: {
              line: splittedText.length - 1,
              character: splittedText[splittedText.length - 1].length,
            },
          },
          message: msg,
        };
      }
      this.connection.sendDiagnostics({
        uri: uri,
        diagnostics: [diagnostic],
      });
      this.connection.sendNotification("bq/totalBytesProcessed", {
        totalBytesProcessed: "ERROR",
      });
    }
  }

  private getConfiguration(uri: string): Thenable<Configuration> {
    function replace(defaultConfig: any, userConfig: any) {
      for (const [k, v] of Object.entries(defaultConfig)) {
        if (typeof v === "object") {
          if (!userConfig) continue;
          replace(defaultConfig[k], userConfig[k]);
        } else {
          if (userConfig && userConfig[k]) {
            defaultConfig[k] = userConfig[k];
          }
        }
      }
    }

    if (!this.hasConfigurationCapability) {
      return Promise.resolve(defaultConfiguration);
    }
    let result = this.configurations.get(uri);
    if (!result) {
      result = this.connection.workspace
        .getConfiguration({
          section: "bqExtensionVSCode",
        })
        .then((res) => {
          const config = JSON.parse(JSON.stringify(defaultConfiguration)); // deep copy
          replace(config, res);
          return config;
        });
      this.configurations.set(uri, result);
    }
    return result;
  }

  private getDocInfo(uri: string) {
    return {
      text: this.uriToText[uri],
      tokens: this.uriToTokens[uri],
      cst: this.uriToCst[uri],
    };
  }

  private getSmallestNameSpace(nameSpaces: NameSpace[]) {
    let smallestNameSpace = nameSpaces[0];
    for (let i = 1; i < nameSpaces.length; i++) {
      if (
        util.positionBetween(
          {
            line: nameSpaces[i].start.line,
            character: nameSpaces[i].start.column,
          },
          {
            line: smallestNameSpace.start.line,
            character: smallestNameSpace.start.column,
          },
          {
            line: smallestNameSpace.end.line,
            character: smallestNameSpace.end.column,
          }
        ) &&
        util.positionBetween(
          {
            line: nameSpaces[i].end.line,
            character: nameSpaces[i].end.column,
          },
          {
            line: smallestNameSpace.start.line,
            character: smallestNameSpace.start.column,
          },
          {
            line: smallestNameSpace.end.line,
            character: smallestNameSpace.end.column,
          }
        )
      ) {
        smallestNameSpace = nameSpaces[i];
      }
    }
    return smallestNameSpace;
  }

  public register() {
    this.documents.listen(this.connection);
    this.documents.onDidSave((change) => {
      this.getConfiguration(change.document.uri).then((config) => {
        if (config.diagnostic.dryRunOnSave) this.dryRun(change.document.uri);
      });
    });
    this.documents.onDidChangeContent((change) => {
      this.updateDocumentInfo(change);
    });
    this.documents.onDidOpen((change) => {
      const uri = change.document.uri;
      this.uriToText[uri] = "";
      this.uriToTokens[uri] = [];
      this.uriToCst[uri] = [];
      this.updateDocumentInfo(change);
    });
    // Register all the handlers for the LSP events.
    this.connection.onCompletion(this.onCompletion.bind(this));
    this.connection.onDidChangeConfiguration(
      this.onDidChangeConfiguration.bind(this)
    );
    this.connection.onHover(this.onHover.bind(this));
    this.connection.onRequest(
      "bq/clearCache",
      this.onRequestClearCache.bind(this)
    );
    this.connection.onRequest("bq/dryRun", this.onRequestDryRun.bind(this));
    this.connection.onRequest(
      "textDocument/formatting",
      this.onRequestFormatting.bind(this)
    );
    this.connection.onRequest(
      "bq/updateCache",
      this.onRequestUpdateCache.bind(this)
    );
    this.connection.onShutdown(() => {
      this.db.close();
    });
  }

  private async onCompletion(
    position: LSP.CompletionParams
  ): Promise<LSP.CompletionItem[]> {
    /* NOTE
     * You can assume that change event comes before the completion request,
     * otherwise `process.nextTick()` might be needed.
     * https://github.com/Microsoft/vscode/issues/28458
     */
    /* NOTE
     * When this function returns [] (empty array),
     * VSCode's default completion works.
     * https://github.com/microsoft/vscode/issues/21611
     */
    const res: {
      label: string;
      detail?: string;
      kind?: LSP.CompletionItemKind;
    }[] = [];
    const uri = position.textDocument.uri;
    // line, column... position of just typed character (1 based index)
    const line = position.position.line + 1;
    const column = position.position.character;
    const currLiteral = util.getTokenByRowColumn(
      this.getDocInfo(position.textDocument.uri),
      line,
      column
    ).literal;
    const currCharacter =
      this.uriToText[position.textDocument.uri][
        util.getPositionByRowColumn(
          this.getDocInfo(position.textDocument.uri),
          line,
          column
        )
      ];
    if (currCharacter === "`") {
      const projects = (
        await this.db.query("SELECT DISTINCT project FROM projects;", [
          "project",
        ])
      ).map((x: { project: string }) => x.project);
      for (const project of projects) {
        res.push({ label: project });
      }
    } else if (currCharacter === ".") {
      const matchingResult = currLiteral.match(/^`([^`]+)`?$/);
      if (matchingResult) {
        // in ``
        const idents = matchingResult[1].split(".");
        const length = idents.length;
        const datasetsOfDefaultProject = (
          await this.db.query(
            "SELECT DISTINCT dataset FROM datasets WHERE project = ?;",
            [this.defaultProject],
            ["dataset"]
          )
        ).map((x) => x.dataset);
        if (datasetsOfDefaultProject.some((x) => x === idents[0])) {
          // idents[0] is assumed to be dataset name (of defaultProject)
          const tables: string[] = (
            await this.db.query(
              "SELECT DISTINCT table_name FROM columns WHERE project = ? AND dataset = ?",
              [this.defaultProject, idents[0]],
              ["table_name"]
            )
          ).map((x: { table_name: string }) => x.table_name);
          tables.forEach((table) => {
            res.push({ label: table, kind: LSP.CompletionItemKind.Field });
          });
        } else {
          // idents[0] is assumed to be project name
          if (length === 2) {
            const datasets: string[] = (
              await this.db.query(
                "SELECT DISTINCT dataset FROM datasets WHERE project = ?",
                [idents[0]],
                ["dataset"]
              )
            ).map((x: { dataset: string }) => x.dataset);
            datasets.forEach((dataset) => {
              res.push({ label: dataset, kind: LSP.CompletionItemKind.Field });
            });
          } else if (length === 3) {
            const tables: string[] = (
              await this.db.query(
                "SELECT DISTINCT table_name FROM columns WHERE project = ? AND dataset = ?",
                [idents[0], idents[1]],
                ["table_name"]
              )
            ).map((x: { table_name: string }) => x.table_name);
            tables.forEach((table) => {
              res.push({ label: table, kind: LSP.CompletionItemKind.Field });
            });
          } else {
            // something went wrong!
          }
        }
      } else {
        // out of ``
        const currIndex = util.getPositionByRowColumn(
          this.getDocInfo(uri),
          line,
          column
        );
        const newText = this.uriToText[uri];
        const oldText =
          newText.substring(0, currIndex) + newText.substring(currIndex + 1);
        let nameSpaces = await this.createNameSpacesFromText(oldText);
        nameSpaces = nameSpaces.filter((ns) =>
          util.positionBetween(
            { line: line, character: column },
            { line: ns.start.line, character: ns.start.column },
            { line: ns.end.line, character: ns.end.column }
          )
        );
        const tokens = this.uriToTokens[uri];
        let idx = 0;
        tokens.forEach((t, i) => {
          if (t.line === line && t.column <= column) {
            idx = i;
          }
        });
        if (idx === 0) {
          // Something went wrong! Return empty result.
        } else {
          const parent = tokens[idx - 1].literal;
          let largestNameSpace: NameSpace = {
            start: { line: line, column: column },
            end: { line: line, column: column },
            variables: [],
          };
          for (const n of nameSpaces) {
            if (
              util.positionBetween(
                {
                  line: largestNameSpace.start.line,
                  character: largestNameSpace.start.column,
                },
                { line: n.start.line, character: n.start.column },
                { line: n.end.line, character: n.end.column }
              ) &&
              util.positionBetween(
                {
                  line: largestNameSpace.end.line,
                  character: largestNameSpace.end.column,
                },
                { line: n.start.line, character: n.start.column },
                { line: n.end.line, character: n.end.column }
              ) &&
              n.end.line !== Number.MAX_SAFE_INTEGER
            ) {
              largestNameSpace = n;
            }
          }
          const limitedNameSpaces = nameSpaces.filter(
            (n) =>
              util.positionBetween(
                { line: n.start.line, character: n.start.column },
                {
                  line: largestNameSpace.start.line,
                  character: largestNameSpace.start.column,
                },
                {
                  line: largestNameSpace.end.line,
                  character: largestNameSpace.end.column,
                }
              ) &&
              util.positionBetween(
                { line: n.end.line, character: n.end.column },
                {
                  line: largestNameSpace.start.line,
                  character: largestNameSpace.start.column,
                },
                {
                  line: largestNameSpace.end.line,
                  character: largestNameSpace.end.column,
                }
              )
          );
          limitedNameSpaces.forEach((n) => {
            n.variables.forEach((v) => {
              if (v.parent === parent) {
                res.push({
                  label: v.name,
                  kind: LSP.CompletionItemKind.Field,
                  detail: `Table: ${v.parent || "unknown"}, Type: ${
                    v.type || "unknown"
                  }`,
                });
              }
            });
          });
          // in the case of STRUCT
          type Variable = { label: string; type: string };
          if (res.length === 0) {
            // without table name
            let ancestorIdx = idx;
            while (
              0 < ancestorIdx - 2 &&
              tokens[ancestorIdx - 2].literal === "."
            ) {
              ancestorIdx -= 2;
            }
            const nDots = (idx - ancestorIdx) / 2 + 1;
            ancestorIdx -= 1;
            let variables: Variable[] = this.getSmallestNameSpace(
              nameSpaces
            ).variables.map((v) => {
              return { label: v.name, type: v.type || "UNKNOWN" };
            });
            for (let i = 0; i < nDots; i++) {
              const newVariables: Variable[] = [];
              variables.forEach((v) => {
                if (v.label === tokens[ancestorIdx].literal && v.type) {
                  const mattingResult = v.type.match(/^STRUCT<(.+)>$/);
                  if (mattingResult) {
                    util.parseType(mattingResult[1]).forEach((vt) => {
                      const spacePosition = vt.search(" ");
                      newVariables.push({
                        label: vt.substring(0, spacePosition),
                        type: vt.substring(spacePosition + 1),
                      });
                    });
                  }
                }
              });
              variables = newVariables;
              ancestorIdx += 2;
            }
            variables.forEach((v) => {
              res.push({
                label: v.label,
                detail: `Type: ${v.type}`,
                kind: LSP.CompletionItemKind.Field,
              });
            });
          }
          if (res.length === 0) {
            // with table name
            let ancestorIdx = idx;
            while (
              0 < ancestorIdx - 2 &&
              tokens[ancestorIdx - 2].literal === "."
            ) {
              ancestorIdx -= 2;
            }
            const nDots = (idx - ancestorIdx) / 2 + 1;
            ancestorIdx -= 1;
            let variables: Variable[] = [];
            limitedNameSpaces.forEach((n) => {
              n.variables.forEach((v) => {
                if (v.parent === tokens[ancestorIdx].literal) {
                  variables.push({
                    label: v.name,
                    type: v.type || "UNKNOWN",
                  });
                }
              });
            });
            ancestorIdx += 2;
            for (let i = 0; i < nDots - 1; i++) {
              const newVariables: Variable[] = [];
              variables.forEach((v) => {
                if (v.label === tokens[ancestorIdx].literal && v.type) {
                  const mattingResult = v.type.match(/^STRUCT<(.+)>$/);
                  if (mattingResult) {
                    util.parseType(mattingResult[1]).forEach((vt) => {
                      const spacePosition = vt.search(" ");
                      newVariables.push({
                        label: vt.substring(0, spacePosition),
                        type: vt.substring(spacePosition + 1),
                      });
                    });
                  }
                }
              });
              variables = newVariables;
              ancestorIdx += 2;
            }
            variables.forEach((v) => {
              res.push({
                label: v.label,
                detail: `Type: ${v.type}`,
                kind: LSP.CompletionItemKind.Field,
              });
            });
          }
        }
      }
    } else {
      let nameSpaces = await this.createNameSpaces(uri);
      nameSpaces = nameSpaces.filter((ns) =>
        util.positionBetween(
          { line: line, character: column },
          { line: ns.start.line, character: ns.start.column },
          { line: ns.end.line, character: ns.end.column }
        )
      );
      if (nameSpaces.length !== 0) {
        const smallestNameSpace = this.getSmallestNameSpace(nameSpaces);
        const parents = new Set(
          smallestNameSpace.variables.map((x) => x.parent)
        );
        parents.forEach((x) => {
          if (x) {
            res.push({ label: x, kind: LSP.CompletionItemKind.Struct });
          }
        });
        smallestNameSpace.variables.forEach((variable) => {
          res.push({
            label: variable.name,
            kind: LSP.CompletionItemKind.Field,
            detail: `Table: ${variable.parent || "unknown"}, Type: ${
              variable.type || "unknown"
            }`,
          });
        });
      }
      /*
       * Reserved keywords and functions are not suggested without leading characters.
       * If they are suggested, it will be difficult to find the column you want.
       */
      if (res.length === 0 || !currCharacter.match(/^[, ]$/)) {
        new Set(reservedKeywords).forEach((x) => {
          res.push({ label: x, kind: LSP.CompletionItemKind.Keyword });
        });
        globalFunctions.forEach((x) => {
          res.push({ label: x, kind: LSP.CompletionItemKind.Function });
        });
      }
    }
    return res;
  }

  private onDidChangeConfiguration(_: LSP.DidChangeConfigurationParams) {
    this.configurations.clear();
  }

  private async onHover(params: LSP.TextDocumentPositionParams) {
    const uri = params.textDocument.uri;
    if (this.uriToCst[uri]) {
      const res = await this.provideHoverMessage(
        this.getDocInfo(uri),
        params.position
      );
      return res;
    } else {
      return { contents: [] };
    }
  }

  private async onRequestClearCache(_: any) {
    this.db.clearCache();
    return "The cache was cleared successfully.";
  }

  private async onRequestDryRun(params: { uri: string }) {
    await this.dryRun(params.uri);
    return null;
  }

  private async onRequestFormatting(params: LSP.DocumentFormattingParams) {
    const config = await this.getConfiguration(params.textDocument.uri);
    const originalText = this.uriToText[params.textDocument.uri];
    const splittedOriginalText = originalText.split("\n");
    const formattedText = prettier
      .format(originalText, {
        parser: "sql-parse",
        ...config.formatting,
      })
      .slice(0, -1); // remove unnecessary \n
    return [
      {
        range: {
          start: { line: 0, character: 0 },
          end: {
            line: splittedOriginalText.length - 1,
            character:
              splittedOriginalText[splittedOriginalText.length - 1].length, // `-1` is not needed
          },
        },
        newText: formattedText,
      },
    ];
  }

  private async onRequestUpdateCache(_: any) {
    await this.db.updateCache(Object.values(this.uriToText));
    return "The cache was updated successfully.";
  }

  private async provideHoverMessage(
    docInfo: util.DocumentInfo,
    position: LSP.Position
  ) {
    function replaceTableSuffix(s: string) {
      return s.replace(/([^0-9])[0-9]{8}$/, "$1*");
    }
    const msgs: string[] = [];
    const token = util.getTokenByRowColumn(
      docInfo,
      position.line + 1,
      position.character + 1
    );
    const matchingResult = token.literal.match(/^`(.+)`$/);
    if (matchingResult) {
      const idents = matchingResult[1].split(".");
      let queryResults: { column: string; data_type: string }[] = [];
      if (idents.length === 3) {
        // idents[0] is assumed to be project name
        queryResults = await this.db.query(
          `SELECT DISTINCT column, data_type FROM columns WHERE project = ? AND dataset = ? AND table_name = ?;`,
          [idents[0], idents[1], replaceTableSuffix(idents[2])],
          ["column", "data_type"]
        );
      } else if (idents.length === 2) {
        // idents[0] is assumed to be dataset name
        queryResults = await this.db.query(
          `SELECT DISTINCT column, data_type FROM columns WHERE project = ? AND dataset = ? AND table_name = ?;`,
          [this.defaultProject, idents[0], replaceTableSuffix(idents[1])],
          ["column", "data_type"]
        );
      }
      queryResults.forEach((x) => {
        msgs.push(`${x.column}: ${x.data_type}`);
      });
    }
    return { contents: msgs };
  }
  private updateDocumentInfo(
    change: LSP.TextDocumentChangeEvent<TextDocument>
  ) {
    const uri = change.document.uri;
    this.uriToText[uri] = change.document.getText();
    const text = change.document.getText();
    try {
      this.uriToTokens[uri] = bq2cst.tokenize(text);
      this.uriToCst[uri] = bq2cst.parse(text);
      this.connection.sendDiagnostics({
        uri: uri,
        diagnostics: [],
      });
    } catch (err: any) {
      if (err.line && err.column && err.message) {
        let errorPosition = { line: err.line - 1, character: err.column - 1 };
        const splittedText = text.trimEnd().split("\n");
        const finalCharaPosition = {
          line: splittedText.length - 1,
          character: splittedText[splittedText.length - 1].length - 1,
        };
        if (
          !util.positionBetween(
            errorPosition,
            { line: 0, character: 0 },
            finalCharaPosition
          )
        ) {
          errorPosition = finalCharaPosition;
        }
        // NOTE
        // https://code.visualstudio.com/api/language-extensions/language-server-extension-guide#diagnostics-tips-and-tricks
        // If the start and end positions are the same, VSCode will underline the word at that position.
        // Other editors may fail to underline.
        this.getConfiguration(uri).then((config) => {
          const diagnostic: LSP.Diagnostic = {
            severity: LSP.DiagnosticSeverity.Error,
            range: {
              start: errorPosition,
              end: config.diagnostic.forVSCode
                ? errorPosition
                : {
                    line: errorPosition.line,
                    character: errorPosition.character + 1,
                  },
            },
            message: err.message,
          };
          this.connection.sendDiagnostics({
            uri: uri,
            diagnostics: [diagnostic],
          });
        });
      }
    }
  }

  private async createNameSpaces(uri: string): Promise<NameSpace[]> {
    const cst = this.uriToCst[uri];
    const nameSpaces: NameSpace[] = [];
    const promises = cst.map((node) => {
      return this.pushNameSpaceOfNode(node, nameSpaces);
    });
    await Promise.all(promises);
    return nameSpaces;
  }

  private async createNameSpacesFromText(text: string): Promise<NameSpace[]> {
    const cst = bq2cst.parse(text);
    const nameSpaces: NameSpace[] = [];
    const promises = cst.map((node) => {
      return this.pushNameSpaceOfNode(node, nameSpaces);
    });
    await Promise.all(promises);
    return nameSpaces;
  }

  private async pushNameSpaceOfNode(
    node: bq2cst.UnknownNode,
    parent: NameSpace[]
  ) {
    if (node.node_type === "SelectStatement") {
      const variables: CompletionItem[] = [];
      const range = util.getNodeRange(node);
      if (!range) {
        throw new Error("something went wrong!");
      }
      const from = node.children.from;
      if (from && from.Node.node_type === "KeywordWithExpr") {
        const with_ = node.children.with;
        if (with_ && with_.Node.node_type === "WithClause") {
          await this.findVariablesInsideSelectStatment(
            variables,
            from.Node,
            with_.Node
          );
        } else {
          await this.findVariablesInsideSelectStatment(variables, from.Node);
        }
      }
      parent.push({
        start: range.start,
        end: range.end,
        variables: variables,
      });
    }
    for (const [_, v] of Object.entries(node.children)) {
      if (util.isNodeChild(v)) {
        await this.pushNameSpaceOfNode(v.Node, parent);
      } else if (util.isNodeVecChild(v)) {
        const promises = v.NodeVec.map((n) =>
          this.pushNameSpaceOfNode(n, parent)
        );
        await Promise.all(promises);
      }
    }
  }

  private async findVariablesInsideSelectStatment(
    output: CompletionItem[],
    from: bq2cst.KeywordWithExpr,
    with_?: bq2cst.WithClause
  ) {
    async function findVariable(
      this: BQLanguageServer,
      fromItem: bq2cst.UnknownNode,
      parent?: string
    ) {
      if (fromItem.node_type === "JoinOperator") {
        await findVariable.call(this, fromItem.children.left.Node);
        await findVariable.call(this, fromItem.children.right.Node);
      } else if (fromItem.node_type === "Identifier") {
        const literal = fromItem.token.literal;
        const explicitAlias =
          fromItem.children.alias && fromItem.children.alias.Node.token
            ? fromItem.children.alias.Node.token.literal
            : undefined;
        const mattingResult = literal.match(/^`(.+)`$/);
        if (mattingResult) {
          const idents = mattingResult[1].split(".");
          if (idents.length === 3) {
            // idents[0] is assumed to be project
            const columns = (
              await this.db.query(
                "SELECT DISTINCT column, data_type FROM columns WHERE project = ? AND dataset = ? AND table_name = ?;",
                [idents[0], idents[1], idents[2]],
                ["column", "data_type"]
              )
            ).map((x: { column: string; data_type: string }) => {
              return { name: x.column, type: x.data_type };
            });
            columns.forEach((column: { name: string; type: string }) => {
              output.push({
                name: column.name,
                parent: explicitAlias || idents[2],
                type: column.type,
              });
            });
          } else if (idents.length == 2) {
            // idents[0] is assumed to be dataset
            const columns = (
              await this.db.query(
                "SELECT DISTINCT column, data_type FROM columns WHERE project = ? AND dataset = ? AND table_name = ?;",
                [this.defaultProject, idents[0], idents[1]],
                ["column", "data_type"]
              )
            ).map((x: { column: string; data_type: string }) => {
              return { name: x.column, type: x.data_type };
            });
            columns.forEach((column: { name: string; type: string }) => {
              output.push({
                name: column.name,
                parent: explicitAlias || idents[1],
                type: column.type,
              });
            });
          }
        } else if (with_) {
          const withQueries = with_.children.queries
            .NodeVec as bq2cst.WithQuery[];
          const promises = withQueries.map((query) => {
            const alias = query.token.literal;
            if (alias === literal) {
              return findVariable.call(
                this,
                query.children.stmt.Node,
                explicitAlias || query.token.literal
              );
            } else {
              return Promise.resolve();
            }
          });
          await Promise.all(promises);
        }
      } else if (fromItem.node_type === "GroupedStatement") {
        const stmt = fromItem.children.stmt.Node;
        const explicitAlias =
          fromItem.children.alias && fromItem.children.alias.Node.token
            ? fromItem.children.alias.Node.token.literal
            : undefined;
        if (stmt.node_type === "SelectStatement") {
          const unknowns = stmt.children.exprs.NodeVec;
          unknowns.forEach((unknown) => {
            const expr = unknown as bq2cst.Expr; // to satisfy compiler
            if (expr.children.alias) {
              output.push({
                name: expr.children.alias.Node.token!.literal,
                parent: explicitAlias || parent, // `parent` is passed by withQuery
              });
            } else if (unknown.node_type === "Identifier") {
              output.push({
                name: unknown.token.literal,
                parent: explicitAlias || parent, // `parent` is passed by withQuery
              });
            }
          });
        }
      }
    }
    const fromItem = from.children.expr.Node;
    await findVariable.call(this, fromItem);
  }
}
