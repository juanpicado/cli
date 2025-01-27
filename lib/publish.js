const util = require('util')
const log = require('npmlog')
const semver = require('semver')
const pack = require('libnpmpack')
const libpub = require('libnpmpublish').publish
const runScript = require('@npmcli/run-script')
const pacote = require('pacote')
const npa = require('npm-package-arg')
const npmFetch = require('npm-registry-fetch')

const otplease = require('./utils/otplease.js')
const { getContents, logTar } = require('./utils/tar.js')
const getWorkspaces = require('./workspaces/get-workspaces.js')

// for historical reasons, publishConfig in package.json can contain ANY config
// keys that npm supports in .npmrc files and elsewhere.  We *may* want to
// revisit this at some point, and have a minimal set that's a SemVer-major
// change that ought to get a RFC written on it.
const flatten = require('./utils/config/flatten.js')

// this is the only case in the CLI where we want to use the old full slow
// 'read-package-json' module, because we want to pull in all the defaults and
// metadata, like git sha's and default scripts and all that.
const readJson = util.promisify(require('read-package-json'))

const BaseCommand = require('./base-command.js')
class Publish extends BaseCommand {
  static get description () {
    return 'Publish a package'
  }

  /* istanbul ignore next - see test/lib/load-all-commands.js */
  static get name () {
    return 'publish'
  }

  /* istanbul ignore next - see test/lib/load-all-commands.js */
  static get params () {
    return ['tag', 'access', 'dry-run', 'otp', 'workspace', 'workspaces']
  }

  /* istanbul ignore next - see test/lib/load-all-commands.js */
  static get usage () {
    return [
      '[<folder>]',
    ]
  }

  exec (args, cb) {
    this.publish(args).then(() => cb()).catch(cb)
  }

  execWorkspaces (args, filters, cb) {
    this.publishWorkspaces(args, filters).then(() => cb()).catch(cb)
  }

  async publish (args) {
    if (args.length === 0)
      args = ['.']
    if (args.length !== 1)
      throw this.usage

    log.verbose('publish', args)

    const unicode = this.npm.config.get('unicode')
    const dryRun = this.npm.config.get('dry-run')
    const json = this.npm.config.get('json')
    const defaultTag = this.npm.config.get('tag')
    const silent = log.level === 'silent'

    if (semver.validRange(defaultTag))
      throw new Error('Tag name must not be a valid SemVer range: ' + defaultTag.trim())

    const opts = { ...this.npm.flatOptions }

    // you can publish name@version, ./foo.tgz, etc.
    // even though the default is the 'file:.' cwd.
    const spec = npa(args[0])
    let manifest = await this.getManifest(spec, opts)

    if (manifest.publishConfig)
      flatten(manifest.publishConfig, opts)

    // only run scripts for directory type publishes
    if (spec.type === 'directory') {
      await runScript({
        event: 'prepublishOnly',
        path: spec.fetchSpec,
        stdio: 'inherit',
        pkg: manifest,
        banner: !silent,
      })
    }

    const tarballData = await pack(spec, opts)
    const pkgContents = await getContents(manifest, tarballData)

    // The purpose of re-reading the manifest is in case it changed,
    // so that we send the latest and greatest thing to the registry
    // note that publishConfig might have changed as well!
    manifest = await this.getManifest(spec, opts)
    if (manifest.publishConfig)
      flatten(manifest.publishConfig, opts)

    // note that logTar calls npmlog.notice(), so if we ARE in silent mode,
    // this will do nothing, but we still want it in the debuglog if it fails.
    if (!json)
      logTar(pkgContents, { log, unicode })

    if (!dryRun) {
      const resolved = npa.resolve(manifest.name, manifest.version)
      const registry = npmFetch.pickRegistry(resolved, opts)
      const creds = this.npm.config.getCredentialsByURI(registry)
      if (!creds.token && !creds.username) {
        throw Object.assign(new Error('This command requires you to be logged in.'), {
          code: 'ENEEDAUTH',
        })
      }
      await otplease(opts, opts => libpub(manifest, tarballData, opts))
    }

    if (spec.type === 'directory') {
      await runScript({
        event: 'publish',
        path: spec.fetchSpec,
        stdio: 'inherit',
        pkg: manifest,
        banner: !silent,
      })

      await runScript({
        event: 'postpublish',
        path: spec.fetchSpec,
        stdio: 'inherit',
        pkg: manifest,
        banner: !silent,
      })
    }

    if (!this.workspaces) {
      if (!silent && json)
        this.npm.output(JSON.stringify(pkgContents, null, 2))
      else if (!silent)
        this.npm.output(`+ ${pkgContents.id}`)
    }

    return pkgContents
  }

  async publishWorkspaces (args, filters) {
    // Suppresses JSON output in publish() so we can handle it here
    this.workspaces = true

    const results = {}
    const json = this.npm.config.get('json')
    const silent = log.level === 'silent'
    const workspaces =
      await getWorkspaces(filters, { path: this.npm.localPrefix })
    for (const [name, workspace] of workspaces.entries()) {
      const pkgContents = await this.publish([workspace])
      // This needs to be in-line w/ the rest of the output that non-JSON
      // publish generates
      if (!silent && !json)
        this.npm.output(`+ ${pkgContents.id}`)
      else
        results[name] = pkgContents
    }

    if (!silent && json)
      this.npm.output(JSON.stringify(results, null, 2))
  }

  // if it's a directory, read it from the file system
  // otherwise, get the full metadata from whatever it is
  getManifest (spec, opts) {
    if (spec.type === 'directory')
      return readJson(`${spec.fetchSpec}/package.json`)
    return pacote.manifest(spec, { ...opts, fullMetadata: true })
  }
}
module.exports = Publish
