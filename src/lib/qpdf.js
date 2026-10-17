// AES-256 encryption/decryption via qpdf compiled to WASM (runs locally in the browser).
let modulePromise;
async function create(logs) {
  const { default: createModule } = await import("@neslinesli93/qpdf-wasm");
  return createModule({
    locateFile: () => "/vendor/qpdf/qpdf.wasm",
    noInitialRun: true,
    print: (m) => logs.push(m),
    printErr: (m) => logs.push(m),
  });
}

async function run(bytes, args) {
  const logs = [];
  const qpdf = await create(logs);
  qpdf.FS.writeFile("/in.pdf", bytes);
  let code;
  try {
    code = qpdf.callMain([...args, "/in.pdf", "/out.pdf"]);
  } catch (e) {
    code = typeof e?.status === "number" ? e.status : 2;
  }
  // qpdf exit code 3 = completed with warnings
  if (code !== 0 && code !== 3) {
    const err = new Error(logs.join("\n") || `qpdf failed (${code})`);
    err.logs = logs;
    err.wrongPassword = /invalid password/i.test(err.message);
    throw err;
  }
  return qpdf.FS.readFile("/out.pdf");
}

/**
 * permissions: {print: 'full'|'low'|'none', modify: 'all'|'annotate'|'form'|'assembly'|'none', extract: bool}
 */
export function encryptPdf(bytes, { userPassword = "", ownerPassword, permissions = {} }) {
  const owner = ownerPassword || userPassword || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const args = [
    "--encrypt", userPassword, owner, "256",
    `--print=${permissions.print || "full"}`,
    `--modify=${permissions.modify || "all"}`,
    `--extract=${permissions.extract === false ? "n" : "y"}`,
    "--",
  ];
  return run(bytes, args);
}

/** qpdf's messages are not capturable here, so ask pdf.js whether the password is the problem. */
async function passwordRejected(bytes, password) {
  const { openDoc } = await import("./pdf.js");
  try {
    (await openDoc(bytes, password)).destroy();
    return false;
  } catch (e) {
    return e?.name === "PasswordException";
  }
}

export async function decryptPdf(bytes, password) {
  try {
    return await run(bytes, [`--password=${password}`, "--decrypt"]);
  } catch (e) {
    if (await passwordRejected(bytes, password)) {
      const err = new Error("Incorrect password");
      err.wrongPassword = true;
      throw err;
    }
    throw e;
  }
}
