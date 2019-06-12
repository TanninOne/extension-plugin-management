import {updatePluginOrder} from './actions/loadOrder';
import {IPlugins, IPluginsLoot} from './types/IPlugins';
import {gameSupported, pluginPath} from './util/gameSupport';

import * as Bluebird from 'bluebird';
import { remote } from 'electron';
import getVersion from 'exe-version';
import { LootAsync } from 'loot';
import * as path from 'path';
import {} from 'redux-thunk';
import {actions, fs, log, selectors, types, util} from 'vortex-api';
import i18next from 'i18next';
import { setGroup, removeRule, removeGroupRule } from './actions/userlist';

const LOOT_LIST_REVISION = 'v0.14';

const LootProm: any = Bluebird.promisifyAll(LootAsync);

enum EdgeType {
  group = "group",
  hardcoded = "hardcoded",
  master = "master",
  masterFlag = "masterFlag",
  masterlistLoadAfter = "masterlistLoadAfter",
  masterlistRequirement = "masterlistRequirement",
  userLoadAfter = "userlistLoadAfter",
  userRequirement = "userlistRequirement",
  overlap = "overlap",
  tieBreak = "tieBreak",
};

interface ICycleEdge {
  name: string;
  typeOfEdgeToNextVertex: EdgeType;
}

class LootInterface {
  private mExtensionApi: types.IExtensionApi;
  private mInitPromise: Bluebird<{ game: string, loot: typeof LootProm }> =
    Bluebird.resolve({ game: undefined, loot: undefined });
  private mSortPromise: Bluebird<string[]> = Bluebird.resolve([]);

  private mUserlistTime: Date;

  constructor(context: types.IExtensionContext) {
    const store = context.api.store;

    this.mExtensionApi = context.api;

    // when the game changes, we need to re-initialize loot for that game
    context.api.events.on('gamemode-activated',
      gameMode => this.onGameModeChanged(context, gameMode));

    { // in case the initial gamemode-activated event was already sent,
      // initialize right away
      const gameMode = selectors.activeGameId(store.getState());
      if (gameMode) {
        this.onGameModeChanged(context, gameMode);
      }
    }

    context.api.events.on('restart-helpers', async () => {
      const { game, loot } = await this.mInitPromise;
      const gameMode = selectors.activeGameId(store.getState());
      this.startStopLoot(context, gameMode, loot);
    });

    // on demand, re-sort the plugin list
    context.api.events.on('autosort-plugins', this.onSort);

    context.api.events.on('plugin-details',
      (gameId: string, plugins: string[], callback: (result: IPluginsLoot) => void) =>
        this.pluginDetails(context, gameId, plugins, callback));
  }

  public async wait(): Promise<void> {
    try {
      await this.mInitPromise;
      await this.mSortPromise;
    } catch (err) {}
  }

  public async resetMasterlist(): Promise<string> {
    const { store } = this.mExtensionApi;
    let { game, loot } = await this.mInitPromise;

    const state = store.getState();
    const gameMode = selectors.activeGameId(state);

    if ((gameMode !== game)
      || !gameSupported(gameMode)
      || (loot === undefined)
      || loot.isClosed()) {
      return 'LOOT not initialised';
    }

    const masterlistPath = path.join(remote.app.getPath('userData'), gameMode,
      'masterlist');

    await fs.removeAsync(masterlistPath);
    // have to restart loot so it does refetch the masterlist
    this.mInitPromise = this.init(gameMode, this.gamePath);
    loot = (await this.mInitPromise).loot;

    return await loot.updateMasterlistAsync(
        path.join(masterlistPath, 'masterlist.yaml'),
        `https://github.com/loot/${this.convertGameId(game, true)}.git`,
        LOOT_LIST_REVISION)
      ? null
      // how would that happen?
      : 'Masterlist unmodified';
  }

  public sort(): Promise<void> {
    let error: Error = null;
    return this.onSort(true, err => error = err)
      .then(() => (error !== null)
        ? Promise.reject(error)
        : Promise.resolve());
  }

  private onSort = async (manual: boolean, callback?: (err: Error) => void) => {
    const { store } = this.mExtensionApi;
    try {
      if (manual || store.getState().settings.plugins.autoSort) {
        // ensure initialisation is done
        const { game, loot } = await this.mInitPromise;

        const state = store.getState();
        const gameMode = selectors.activeGameId(state);
        if ((gameMode !== game)
            || !gameSupported(gameMode)
            || (loot === undefined)
            || loot.isClosed()) {
          return;
        }
        const pluginList: IPlugins = state.session.plugins.pluginList;

        const lo = (pluginKey: string) =>
          (state.loadOrder[pluginKey] || { loadOrder: -1 }).loadOrder;

        const pluginNames: string[] = Object
          // from all plugins
          .keys(pluginList)
          // sort only the ones that are deployed
          .filter((pluginId: string) => pluginList[pluginId].deployed)
          // apply existing ordering (as far as available)
          .sort((lhs, rhs) => lo(lhs) - lo(rhs))
          .map((pluginId: string) => path.basename(pluginList[pluginId].filePath));

        // ensure no other sort is in progress
        try {
          await this.mSortPromise;
        // tslint:disable-next-line:no-empty
        } catch (err) {}

        await this.doSort(pluginNames, gameMode, loot);
      }
      if (callback !== undefined) {
        callback(null);
      }
      return Promise.resolve();
    } catch (err) {
      if (callback !== undefined) {
        callback(err);
      }
    }
  }

  private get gamePath() {
    const { store } = this.mExtensionApi;
    const discovery = selectors.currentGameDiscovery(store.getState());
    if (discovery === undefined) {
      // no game selected
      return undefined;
    }
    return discovery.path;
  }

  private async doSort(pluginNames: string[], gameMode: string, loot: typeof LootProm) {
    const { store } = this.mExtensionApi;
    try {
      this.mExtensionApi.dismissNotification('loot-cycle-warning');
      store.dispatch(actions.startActivity('plugins', 'sorting'));
      this.mSortPromise = this.readLists(gameMode, loot)
        .then(() => loot.sortPluginsAsync(pluginNames))
        .catch(err => (err.message === 'already closed')
          ? Promise.resolve([])
          : Promise.reject(err));
      const sorted: string[] = await this.mSortPromise;
      store.dispatch(updatePluginOrder(sorted, false));
    } catch (err) {
      log('info', 'loot failed', { error: err.message });
      if (err.message.startsWith('Cyclic interaction')) {
        this.reportCycle(err, loot);
      } else if (err.message.endsWith('is not a valid plugin')) {
        const pluginName = err.message.replace(/"([^"]*)" is not a valid plugin/, '$1');
        const reportErr = () => {
          this.mExtensionApi.sendNotification({
            id: 'loot-failed',
            type: 'warning',
            message: this.mExtensionApi.translate('Plugins not sorted because: {{msg}}',
              { replace: { msg: err.message }, ns: 'gamebryo-plugin' }),
          });
        };
        try {
          await fs.statAsync(path.join(this.gamePath, 'data', pluginName));
          reportErr();
        } catch (err) {
          const idx = pluginNames.indexOf(pluginName);
          if (idx !== -1) {
            const newList = pluginNames.slice();
            newList.splice(idx, 1);
            return await this.doSort(newList, gameMode, loot);
          } else {
            reportErr();
          }
        }
      } else if (err.message.match(/The group "[^"]*" does not exist/)) {
        this.mExtensionApi.sendNotification({
          id: 'loot-failed',
          type: 'warning',
          message: this.mExtensionApi.translate('Plugins not sorted because: {{msg}}',
            { replace: { msg: err.message }, ns: 'gamebryo-plugin' }),
        });
      } else if (err.message.indexOf('Failed to evaluate condition') !== -1) {
        let match = err.message.match(
          /Failed to evaluate condition ".*version\("([^"]*\.exe)",.*/);
        if (match) {
          let exists = false;
          let fileSize = 0;
          let md5sum = '';
          let version = '';
          const filePath = path.resolve(this.gamePath, 'data', match[1]);

          const report = () => {
            this.mExtensionApi.showErrorNotification('LOOT operation failed', {
              error: err,
              File: filePath,
              Exists: exists,
              Size: fileSize,
              MD5: md5sum,
              Version: version,
            }, {
                id: 'loot-failed',
                allowReport: this.allowReport(err),
              });
          };

          try {
            const stats = fs.statSync(filePath);
            exists = true;
            fileSize = stats.size;
            version = getVersion(filePath) || 'unknown';
            (util as any).fileMD5(filePath)
              .then(hash => md5sum = hash)
              .finally(() => {
                report();
              });
          } catch (err) {
            report();
          }
        } else {
          this.mExtensionApi.showErrorNotification('LOOT operation failed', err, {
            id: 'loot-failed',
            allowReport: this.allowReport(err),
          });
        }
      } else if (err.message === 'already closed') {
        // loot process terminated, don't really care about the result anyway
      } else {
        this.mExtensionApi.showErrorNotification('LOOT operation failed', err, {
          id: 'loot-failed',
          allowReport: this.allowReport(err),
        });
      }
    } finally {
      store.dispatch(actions.stopActivity('plugins', 'sorting'));
    }
  }

  private allowReport(err: Error) {
    return err.message.indexOf('boost::filesystem') === -1;
  }

  private onGameModeChanged = async (context: types.IExtensionContext, gameMode: string) => {
    const initProm = this.mInitPromise;

    let onRes: (x: { game: string, loot: LootAsync }) => void;

    this.mInitPromise = new Bluebird<{ game: string, loot: LootAsync }>((resolve) => {
      onRes = resolve;
    });

    const { game, loot }: { game: string, loot: LootAsync } = await initProm;
    if (gameMode === game) {
      this.mInitPromise = initProm;
      onRes({ game, loot });
      // no change
      return;
    } else {
      this.startStopLoot(context, gameMode, loot);
      onRes(await this.mInitPromise);
    }
  }

  private startStopLoot(context: types.IExtensionContext, gameMode: string, loot: LootAsync) {
    if (loot !== undefined) {
      // close the loot instance of the old game, but give it a little time, otherwise it may try to
      // to run instructions after being closed.
      // TODO: Would be nice if this was deterministic...
      setTimeout(() => {
        loot.close();
      }, 5000);
    }
    const gamePath = this.gamePath;
    if (gameSupported(gameMode)) {
      try {
        this.mInitPromise = this.init(gameMode, gamePath);
      } catch (err) {
        context.api.showErrorNotification('Failed to initialize LOOT', {
          error: err,
          Game: gameMode,
          Path: gamePath,
        });
        this.mInitPromise = Bluebird.resolve({ game: gameMode, loot: undefined });
      }
    } else {
      this.mInitPromise = Bluebird.resolve({ game: gameMode, loot: undefined });
    }
  }

  private async getLoot(context: types.IExtensionContext, gameId: string):
        Promise<{ game: string, loot: typeof LootProm }> {
    let res = await this.mInitPromise;
    if (res.game !== gameId) {
      this.onGameModeChanged(context, gameId);
      res = await this.mInitPromise;
    }
    return res;
  }

  private pluginDetails = async (context: types.IExtensionContext, gameId: string, plugins: string[],
                                 callback: (result: IPluginsLoot) => void) => {
    const { game, loot } = await this.getLoot(context, gameId);
    if ((loot === undefined) || loot.isClosed()) {
      callback({});
      return;
    }

    try {
      // not really interested in these messages but apparently it's the only way to make the api
      // drop its cache of _all_ previously evaluated conditions
      await loot.getGeneralMessagesAsync(true);
      if (loot.isClosed()) {
        callback({});
        return;
      }
      await loot.loadCurrentLoadOrderStateAsync();
    } catch (err) {
      this.mExtensionApi.showErrorNotification(
        'There were errors getting plugin information from LOOT',
        err, { allowReport: false, id: 'gamebryo-plugins-loot-meta-error' });
      callback({});
      return;
    }

    const result: IPluginsLoot = {};
    let error: Error;
    let pluginsLoaded = false;
    const state = this.mExtensionApi.store.getState();
    const pluginList: IPlugins = state.session.plugins.pluginList;

    try {
      await loot.loadPluginsAsync(plugins
        .filter(id => (pluginList[id] !== undefined) && pluginList[id].deployed)
        .map(name => name.toLowerCase()), false);
      pluginsLoaded = true;
    } catch (err) {
      if (err.message === 'already closed') {
        return;
      }

      this.mExtensionApi.showErrorNotification('Failed to parse plugins',
                                               err, { allowReport: false });
    }

    let createEmpty = () => ({
      messages: [],
      tags: [],
      cleanliness: [],
      dirtyness: [],
      group: undefined,
      isValidAsLightMaster: false,
      loadsArchive: false,
      version: '',
    });

    let closed = loot.isClosed();
    Promise.all(plugins.map(async (pluginName: string) => {
      if (closed) {
        result[pluginName] = createEmpty();
        return;
      }
      try {
        let meta = await loot.getPluginMetadataAsync(pluginName);
        let info;
        try {
          const id = pluginName.toLowerCase();
          if ((pluginList[id] !== undefined) && pluginList[id].deployed) {
            info = await loot.getPluginAsync(pluginName);
          }
        } catch (err) {
          log('error', 'failed to get plugin info', { pluginName, error: err.message });
        }

        result[pluginName] = {
          messages: meta.messages,
          tags: meta.tags,
          cleanliness: meta.cleanInfo || [],
          dirtyness: meta.dirtyInfo || [],
          group: meta.group,
          isValidAsLightMaster: pluginsLoaded && (info !== undefined) && info.isValidAsLightMaster,
          loadsArchive: pluginsLoaded && (info !== undefined) && info.loadsArchive,
          version: (pluginsLoaded && (info !== undefined)) ? info.version : '',
        };
      } catch (err) {
        result[pluginName] = createEmpty();
        if (err.arg !== undefined) {
          // invalid parameter. This simply means that loot has no meta data for this plugin
          // so that's not a problem
        } else {
          if (err.message === 'already closed') {
            closed = true;
            return;
          }
          log('error', 'Failed to get plugin meta data from loot',
            { pluginName, error: err.message });
          error = err;
        }
      }
    }))
    .then(() => {
      if ((error !== undefined) && !closed) {
        this.mExtensionApi.showErrorNotification(
          'There were errors getting plugin information from LOOT',
          error, { allowReport: false, id: 'gamebryo-plugins-loot-details-error' });
      }
      callback(result);
    });
  }

  // tslint:disable-next-line:member-ordering
  private readLists = Bluebird.method(async (gameMode: string, loot: typeof LootProm) => {
    const t = this.mExtensionApi.translate;
    const masterlistPath = path.join(remote.app.getPath('userData'), gameMode,
                                     'masterlist', 'masterlist.yaml');
    const userlistPath = path.join(remote.app.getPath('userData'), gameMode, 'userlist.yaml');

    let mtime: Date;
    try {
      mtime = (await fs.statAsync(userlistPath)).mtime;
    } catch (err) {
      mtime = null;
    }

    // load & evaluate lists first time we need them and whenever
    // the userlist has changed
    if ((mtime !== null) &&
        // this.mUserlistTime could be undefined or null
        (!this.mUserlistTime ||
         (this.mUserlistTime.getTime() !== mtime.getTime()))) {
      log('info', '(re-)loading loot lists', {
        mtime,
        masterlistPath,
        userlistPath,
        last: this.mUserlistTime,
      });
      try {
        await fs.statAsync(masterlistPath);
        await loot.loadListsAsync(masterlistPath, mtime !== null ? userlistPath : '');
        log('info', 'loaded loot lists');
        this.mUserlistTime = mtime;
      } catch (err) {
        this.mExtensionApi.showErrorNotification('Failed to load master-/userlist', err, {
            allowReport: false,
          } as any);
      }
    }
  });

  private convertGameId(gameMode: string, masterlist: boolean) {
    if (masterlist && (gameMode === 'fallout4vr')) {
      // use the masterlist from fallout 4
      return 'fallout4';
    } else if (gameMode === 'skyrimvr') {
      // no specific support from skyrim vr yet
      return 'skyrimse';
    } else if (gameMode === 'enderal') {
      return 'skyrim';
    }
    return gameMode;
  }

  // tslint:disable-next-line:member-ordering
  private init = Bluebird.method(async (gameMode: string, gamePath: string) => {
    const localPath = pluginPath(gameMode);
    try {
      await fs.ensureDirAsync(localPath);
    } catch (err) {
      this.mExtensionApi.showErrorNotification('Failed to create necessary directory', err, {
          allowReport: false,
        });
    }

    let loot: any;

    try {
      loot = Bluebird.promisifyAll(
        await LootProm.createAsync(this.convertGameId(gameMode, false), gamePath,
                                   localPath, 'en', this.log, this.fork));
    } catch (err) {
      this.mExtensionApi.showErrorNotification('Failed to initialize LOOT', err, {
        allowReport: false,
      } as any);
      return { game: gameMode, loot: undefined };
    }
    const masterlistRepoPath = path.join(remote.app.getPath('userData'), gameMode,
                                         'masterlist');
    const masterlistPath = path.join(masterlistRepoPath, 'masterlist.yaml');
    try {
      await fs.ensureDirAsync(path.dirname(masterlistPath));
      const updated = await loot.updateMasterlistAsync(
          masterlistPath,
          `https://github.com/loot/${this.convertGameId(gameMode, true)}.git`,
          LOOT_LIST_REVISION);
      log('info', 'updated loot masterlist', updated);
      this.mExtensionApi.events.emit('did-update-masterlist');
    } catch (err) {
      const t = this.mExtensionApi.translate;
      this.mExtensionApi.showErrorNotification('Failed to update masterlist', {
        message: t('This might be a temporary network error. '
              + 'If it persists, please delete "{{masterlistPath}}" to force Vortex to '
              + 'download a new copy.', { replace: { masterlistPath: masterlistRepoPath } }),
        error: err,
      }, {
          allowReport: false,
        });
    }

    try {
      // we need to ensure lists get loaded at least once. before sorting there
      // will always be a check if the userlist was changed
      const userlistPath = path.join(remote.app.getPath('userData'), gameMode, 'userlist.yaml');

      let mtime: Date;
      try {
        mtime = (await fs.statAsync(userlistPath)).mtime;
      } catch (err) {
        mtime = null;
      }
      // ensure masterlist is available
      await fs.statAsync(masterlistPath);
      await loot.loadListsAsync(masterlistPath, mtime !== null ? userlistPath : '');
      await loot.loadCurrentLoadOrderStateAsync();
      this.mUserlistTime = mtime;
    } catch (err) {
      this.mExtensionApi.showErrorNotification('Failed to load master-/userlist', err, {
          allowReport: false,
        } as any);
    }

    return { game: gameMode, loot };
  });

  private fork = (modulePath: string, args: string[]) => {
    (this.mExtensionApi as any).runExecutable(process.execPath, [modulePath].concat(args || []), {
      detach: false,
      suggestDeploy: false,
      env: {
        ELECTRON_RUN_AS_NODE: '1',
      },
    })
      .catch(util.UserCanceled, () => null)
      .catch(util.ProcessCanceled, () => null)
      .catch(err => this.mExtensionApi.showErrorNotification('Failed to start LOOT', err));
  }

  private log = (level: number, message: string) => {
    log(this.logLevel(level) as any, message);
  }

  private logLevel(level: number): string {
    switch (level) {
      case 0: return 'debug'; // actually trace
      case 1: return 'debug';
      case 2: return 'info';
      case 3: return 'warn';
      case 4: return 'error';
      case 5: return 'error'; // actually fatal
    }
  }

  private renderEdge(t: typeof i18next.t, edge: ICycleEdge): string {
    switch (edge.typeOfEdgeToNextVertex) {
      case EdgeType.masterlistLoadAfter:
      case EdgeType.masterlistRequirement:
        return t('masterlist');
      case EdgeType.userLoadAfter:
      case EdgeType.userRequirement:
        return t('custom');
      case EdgeType.hardcoded:
        return t('hardcoded');
      case EdgeType.overlap:
        return t('overlap');
      case EdgeType.tieBreak:
        return t('tie breaker');
      default:
        return '???';
    }
  }

  private async describeEdge(t: typeof i18next.t,
                             edge: ICycleEdge, edgeGroup: string,
                             next: ICycleEdge, nextGroup: string,
                             loot: typeof LootProm): Promise<string> {
    switch (edge.typeOfEdgeToNextVertex) {
      case EdgeType.master:
      case EdgeType.masterFlag:
        return t('{{master}} is a master and {{regular}} isn\'t', { replace: {
          master: next.name, regular: edge.name,
        }});
      case EdgeType.masterlistLoadAfter:
      case EdgeType.masterlistRequirement:
        return t('this is a masterlist rule');
      case EdgeType.userLoadAfter:
      case EdgeType.userRequirement:
        return t('this is a custom rule');
      case EdgeType.hardcoded:
        return t('hardcoded');
      case EdgeType.overlap:
        return t('overlap');
      case EdgeType.tieBreak:
        return t('tie breaker');
      case EdgeType.group: {
        const groupPath: ICycleEdge[] =
          await loot.getGroupsPathAsync(edgeGroup || 'default', nextGroup || 'default');
        return t('groups are connected like this: {{path}}', { replace: {
          path: groupPath.map(grp => {
            let connection = grp.typeOfEdgeToNextVertex === 'hardcoded'
              ? ''
              : ` --(${this.renderEdge(t, grp)})->`;
            return `${grp.name}${connection}`;
          }).join(' '),
        } });
      };
    }
  }

  private getGroup(state: any, pluginName: string): { group: string, custom: boolean } {
    let ulEdge = state.userlist.plugins.find(iter => iter.name.toLowerCase() === pluginName.toLowerCase());
    if ((ulEdge !== undefined) && (ulEdge.group !== undefined)) {
      return { group: ulEdge.group, custom: true };
    }
    let mlEdge = state.masterlist.plugins.find(iter => iter.name.toLowerCase() === pluginName.toLowerCase());
    if ((mlEdge !== undefined) && (mlEdge.group !== undefined)) {
      return { group: mlEdge.group, custom: false };
    }
    return { group: undefined, custom: false };
  }

  private async renderCycle(t: typeof i18next.t,
                            cycle: ICycleEdge[],
                            loot: typeof LootProm): Promise<string> {
    const state = this.mExtensionApi.store.getState();
    const lines = await Promise.all(cycle.map(async (edge: ICycleEdge, idx: number) => {
      const next = cycle[(idx + 1) % cycle.length];
      let edgeGroup = this.getGroup(state, edge.name);
      let nextGroup = this.getGroup(state, next.name);

      let groupDescription = edgeGroup.custom
        ? `[tooltip="${t('This group was manually assigned')}"]${edgeGroup.group || 'default'}[/tooltip]`
        : (edgeGroup.group || 'default');
      let edgeDescription = await this.describeEdge(t, edge, edgeGroup.group, next, nextGroup.group, loot);

      let connection = `[tooltip="${edgeDescription}"]-->[/tooltip]`;

      return `${edge.name}@[i]${groupDescription}[/i] ${connection}`;
    }));
    let firstGroup = this.getGroup(state, cycle[0].name);
    return lines.join(' ') + ` ${cycle[0].name}@[i]${firstGroup.group || 'default'}[/i]`;
  }

  private async getSolutions(t: typeof i18next.t,
                             cycle: ICycleEdge[],
                             loot: typeof LootProm): Promise<types.ICheckbox[]> {
    const user = [
      EdgeType.userLoadAfter,
      EdgeType.userRequirement,
    ];

    const result: types.ICheckbox[] = [];

    await Promise.all(cycle.map(async (edge: ICycleEdge, idx: number) => {
      const next = cycle[(idx + 1) % cycle.length];
      if (user.indexOf(edge.typeOfEdgeToNextVertex) !== -1) {
        result.push({
          id: `removerule:${edge.name}:${next.name}:${edge.typeOfEdgeToNextVertex}`,
          text: t('Remove custom rule between "{{name}}" and "{{next}}"', { replace: {
            name: edge.name, next: next.name,
          } }),
          value: false,
        });
      } else if (edge.typeOfEdgeToNextVertex === EdgeType.group) {
        const state = this.mExtensionApi.store.getState();
        let edgeGroup = this.getGroup(state, edge.name);
        let nextGroup = this.getGroup(state, next.name);
        if (edgeGroup.custom) {
          result.push({
            id: `unassign:${edge.name}`,
            text: t('Remove custom group assignment to "{{name}}"', { replace: {
              name: edge.name,
            } }),
            value: false,
          });
        }
        if (nextGroup.custom) {
          result.push({
            id: `unassign:${next.name}`,
            text: t('Remove custom group assignment to "{{name}}"', { replace: {
              name: next.name,
            } }),
            value: false,
          });
        }
        const groupPath: ICycleEdge[] =
          await loot.getGroupsPathAsync(edgeGroup.group || 'default', nextGroup.group || 'default');
        if (groupPath.find(edge => user.indexOf(edge.typeOfEdgeToNextVertex) !== -1)) {
          result.push({
            // Storing the plugin names here instead of the group directly because the plugin names
            //   are file names on disk and thus won't contain colons, meaning we can cleanly
            //   parse this id later, the same would be more complicated with group names
            id: `resetgroups:${edge.name}:${next.name}`,
            text: t('Reset customized groups between "{{first}}@{{firstGroup}}" '
                    + 'and "{{second}}@{{secondGroup}}"', { replace: {
                      first: edge.name,
                      firstGroup: edgeGroup.group || 'default',
                      second: next.name,
                      secondGroup: nextGroup.group || 'default',
                    }}),
            value: false,
          });
        }
      }
    }));

    return result;
  }

  private async applyFix(key: string, loot: typeof LootProm) {
    const api = this.mExtensionApi;

    const args = key.split(':');
    if (args[0] === 'removerule') {
      api.store.dispatch(removeRule(args[2], args[1],
        args[3] === EdgeType.userRequirement ? 'requires' : 'after'));
    } else if (args[0] === 'unassign') {
      api.store.dispatch(setGroup(args[1], undefined));
    } else if (args[0] === 'resetgroups') {
      const state = api.store.getState();
      let edgeGroup = this.getGroup(state, args[1]);
      let nextGroup = this.getGroup(state, args[2]);

      let path: ICycleEdge[] =
        await loot.getGroupsPathAsync(edgeGroup.group || 'default', nextGroup.group || 'default');

      path.forEach((pathEdge, idx) => {
        if ((pathEdge.typeOfEdgeToNextVertex === EdgeType.userLoadAfter)
            || (pathEdge.typeOfEdgeToNextVertex === EdgeType.userRequirement)) {
          const pathNext = path[(idx + 1) % path.length];
          api.store.dispatch(removeGroupRule(pathNext.name || 'default', pathEdge.name || 'default'))
        }
      });

    } else {
      api.showErrorNotification('Invalid fix instruction for cycle, please report this', key);
    }
  }

  private async reportCycle(err: Error, loot: typeof LootProm) {
    const api = this.mExtensionApi;
    const t = api.translate;
    const solutions: types.ICheckbox[] = await this.getSolutions(t, (err as any).cycle, loot);
    const renderedCycle = await this.renderCycle(t, (err as any).cycle, loot);

    const errActions: types.IDialogAction[] = [
      {
        label: 'Close',
      }
    ];
    if (solutions.length > 0) {
      errActions.push({
        label: 'Apply Selected',
      })
    }

    this.mExtensionApi.sendNotification({
      id: 'loot-cycle-warning',
      type: 'warning',
      message: 'Plugins not sorted because of cyclic rules',
      actions: [
        {
          title: 'More',
          action: (dismiss: () => void) => {
            const bbcode = t(
              'LOOT reported a cyclic interaction between rules.<br />'
              + 'In the simplest case this is something like '
              + '[i]"A needs to load after B"[/i] and [i]"B needs to load after A"[/i] '
              + 'but it can be more complicated, involving multiple plugins and groups and '
              + '[i]their[/i] order.<br />',
              { ns: 'gamebryo-plugin' })
              + '<br />' + renderedCycle;
            this.mExtensionApi.showDialog('info', 'Cyclic interaction', {
                  bbcode,
                  checkboxes: solutions,
                }, errActions)
              .then(result => {
                if (result.action === 'Apply Selected') {
                  const selected = Object.keys(result.input)
                    .filter(key => result.input[key]);
                  
                  selected.sort((lhs, rhs) => {
                      // reset groups first because if one of the other commands changes the
                      // groups those might not work any more or reset a different list of groups
                      if (lhs.startsWith('resetgroups')) {
                        return -1;
                      } else if (rhs.startsWith('resetgroups')) {
                        return 1;
                      } else {
                        return lhs.localeCompare(rhs);
                      }
                    })
                    .forEach(key => this.applyFix(key, loot))

                  if (selected.length > 0) {
                    // sort again
                    this.onSort(true);
                  }
                }
              });
          },
        },
      ],
    });
  }
}

export default LootInterface;
