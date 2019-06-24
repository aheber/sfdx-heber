import { flags, SfdxCommand } from "@salesforce/command";
import { Messages } from "@salesforce/core";
import { AnyJson } from "@salesforce/ts-types";
import * as fs from "fs";
import * as globby from "globby";
import { Connection } from "jsforce";
import * as path from "path";
import * as xmljs from "xml-js";
import { zipDirToBase64 } from "./../../../lib/zipUtils";

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages("sfdx-heber", "staticresources-deploy");

export default class Org extends SfdxCommand {
  public static description = messages.getMessage("commandDescription");

  public static examples = [`$ sfdx heber:staticresources:deploy`];

  public static args = [{ name: "file" }];

  // TODO: add check only flag and disable add-missing in check mode
  protected static flagsConfig = {
    // flag with a value (-n, --name=VALUE)
    checkonly: flags.boolean({
      char: "c", // kept "c" to match the force:mdapi:deploy flag
      description: messages.getMessage("checkonlyFlagDescription")
    }),
    createonly: flags.boolean({
      char: "r",
      description: messages.getMessage("createonlyFlagDescription")
    })
  };

  // Comment this out if your command does not require an org username
  protected static requiresUsername = true;

  // Comment this out if your command does not support a hub org username
  protected static supportsDevhubUsername = true;

  // Set this to true if your command requires a project workspace; 'requiresProject' is false by default
  protected static requiresProject = true;

  public async run(): Promise<AnyJson> {
    // this.org is guaranteed because requiresUsername=true, as opposed to supportsUsername
    const conn = this.org.getConnection();

    // Query the org for all static resources
    const result = await conn.tooling.query<StaticResource>(
      "Select Id, Name, ContentType, CacheControl from StaticResource"
    );

    const inOrg = new Map<string, StaticResource>();

    // Organization always only returns one result
    result.records.forEach(r => {
      inOrg.set(r.Name, r);
      // this.ux.log(r.Name);
    });

    const projectJson = ((await this.project.resolveProjectConfig()) as unknown) as ProjectJSON;

    const packagePaths = [];
    projectJson.packageDirectories.forEach(p => {
      packagePaths.push(`${p.path}/**/staticresources/*.resource-meta.xml`);
    });

    const paths = await globby(packagePaths);
    const allStaticResources = new Map<string, StaticResourceOnDisk>();
    const missingStaticResources = new Map<string, StaticResourceOnDisk>();
    // TODO: respect the .forceignore file
    paths.forEach(p => {
      // Get Static Resource name, compare to the in-org list
      // if not present add to the missing list
      // Add to the all-static resource list
      const d = path.parse(p);
      const nameTrimmed = d.name.replace(".resource-meta", "");
      let id;
      allStaticResources.set(nameTrimmed, { path: p, id });
      if (inOrg.has(nameTrimmed)) {
        // this.ux.log(`Org has ${nameTrimmed}`);
        id = inOrg.get(nameTrimmed).Id; // Org has the resource so should update if needed
      } else {
        // this.ux.log(`Org doesn't have ${nameTrimmed}`);
        missingStaticResources.set(nameTrimmed, { path: p });
      }

      allStaticResources.set(nameTrimmed, { path: p, id });
      // this.ux.log(nameTrimmed);
    });

    // Done doing work
    if (this.flags.checkonly) {
      this.ux.log("Would have added");
      missingStaticResources.forEach((val, key) => {
        this.ux.log("Name:", key, "from", val.path);
      });

      return JSON.stringify(missingStaticResources); // TODO Better return
    }

    let workingSRs = allStaticResources;
    if (this.flags.createonly) {
      workingSRs = missingStaticResources;
    }
    workingSRs.forEach(async (val, key) => {
      const d = path.parse(val.path);
      // get Resource XML file so we can capture properties
      // console.log("Path:", val.path);

      const xml = xmljs.xml2js(
        fs.readFileSync(val.path).toString()
      ) as xmljs.Element;
      // console.log(JSON.stringify(xml));
      const s: StaticResource = { Name: key, Id: val.id };

      xml.elements[0].elements.forEach(e => {
        // console.log(e.name);
        if (e.name === "cacheControl") {
          s.CacheControl = e.elements[0].text as "Public" | "Private";
        }
        if (e.name === "contentType") {
          s.ContentType = e.elements[0].text as string;
        }
        if (e.name === "description") {
          s.Description = e.elements[0].text as string;
        }
      });
      // console.log("S:", s);

      const expectedDirPath = path.join(d.dir, key);
      // console.log("ExpectedDirPath", expectedDirPath);
      // find out if this is a directory or a direct resource
      await new Promise((resolve, reject) => {
        fs.lstat(expectedDirPath, async (err, stats) => {
          // Error assumes file doesn't exist
          // TODO: resolve file extension and capture the resourcePath
          // if (err) return console.log(err); // Handle error
          if (err) {
            // console.log(key, "is not a directory/zip resource");
            // find local resource filename
            const resourcePaths = await globby([
              `${expectedDirPath}\.*`,
              `!${val.path}`
            ]);
            resourcePaths.forEach(async p => {
              // console.log("Found Path for", key, "::", p);
              s.Body = fs.readFileSync(p).toString();
              try {
                await this.uploadFile(conn, s);
              } catch (e) {
                reject(e);
              }
            });
            resolve();
            return;
          }

          if (stats.isDirectory()) {
            // Zip up the directory
            zipDirToBase64(expectedDirPath)
              .then(async data => {
                // use the connection to upload to Salesforce via tooling API
                s.Body = data;
                await this.uploadFile(conn, s);
                resolve();
              })
              .catch(zipErr => {
                console.error("Error:", zipErr);
                reject(zipErr);
              });
          }
        });
      });
      // If not then determine the file name and extension
      // set resourcePath
      // if is directory, zip first, set resourcePath
      // get either zip location or file path and send to the org
      // Log that we're adding item
      // Log that item was added successfully
    });

    // Return an object to be displayed with --json
    this.ux.log("Added/Updated");
    workingSRs.forEach((val, key) => {
      this.ux.log("Name:", key, "from", val.path);
    });

    return null; // TODO Better return
  }

  private async uploadFile(conn: Connection, s: StaticResource) {
    let prom;
    const sr = conn.tooling.sobject("StaticResource");
    if (s.Id === undefined) {
      prom = sr.create(s);
    } else {
      prom = sr.update(s);
    }
    // This errors with a REQUIRED_FIELDS_MISSING if the size is too large.
    // Need to test on our side to monitor if this crosses the 5MB line
    prom
      .then(ret => {
        if (!ret.success) {
          return console.error(s.Name, "failed processing due to", ret);
        }
        // this.ux.log(s.Name, "id is", ret.id)
      })
      .catch(pErr => {
        console.error(s.Name, "failed processing due to", pErr);
      });
  }
}

// The types we are working with
interface StaticResource {
  Id?: string;
  Name?: string;
  ContentType?: string;
  CacheControl?: "Public" | "Private";
  Body?: string;
  Description?: string;
}

interface StaticResourceOnDisk {
  path?: string;
  id?: string;
  resourcePath?: string;
}

interface ProjectJSON {
  packageDirectories: PackageDirectory[];
}

interface PackageDirectory {
  path: string;
  default: boolean;
}
