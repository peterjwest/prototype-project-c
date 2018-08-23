import { ipcRenderer } from 'electron';
import * as path from 'path';
import * as nodegit from 'nodegit';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { createStore, applyMiddleware } from 'redux';
import { Provider } from 'react-redux';
import thunk from 'redux-thunk';
import { Event } from 'electron';
import $ from 'classnames';
import { last } from 'lodash';

import reducer, { Store, FileStatus, AppAction } from './reducer';
import { connect, ActionProps } from './connect';

const IS_STAGED = (
  nodegit.Status.STATUS.INDEX_NEW |
  nodegit.Status.STATUS.INDEX_MODIFIED |
  nodegit.Status.STATUS.INDEX_DELETED |
  nodegit.Status.STATUS.INDEX_RENAMED |
  nodegit.Status.STATUS.INDEX_TYPECHANGE
);

interface Hunk {
  index: number;
  lineNumbers: string[];
}

interface LineDiff {
  type: '+' | '-' | ' ';
  text: string;
  lineNumbers: [number, number];
}

interface AppStoreProps {
  name: string;
  branch: string;
  files: FileStatus[];
  diff?: string;
  lineCount: number;
}

interface AppProps extends AppStoreProps, ActionProps<AppAction> {}
interface AppState {}

class App extends React.Component<AppProps, AppState> {
  constructor(props: AppProps) {
    super(props);

    ipcRenderer.on('init', (event: Event, data: { path: string, branch: string }) => {
      this.props.dispatch({ type: 'UpdateRepoAction', name: path.basename(data.path), branch: data.branch });
    });

    ipcRenderer.on('status', (event: Event, data: { files: FileStatus[] }) => {
      this.props.dispatch({ type: 'UpdateStatusAction', files: data.files });
    });

    ipcRenderer.on('diff', (event: Event, data: { diff: string, lineCount: number }) => {
      this.props.dispatch({ type: 'UpdateSelectedFile', diff: data.diff, lineCount: data.lineCount });
    });
  }

  componentWillReceiveProps(nextProps: AppProps) {
    if (nextProps.name !== this.props.name || nextProps.branch !== this.props.branch) {
      document.title = this.getTitle(nextProps);
    }
  }

  getTitle(props: AppProps) {
    return props.name ? `${props.name} (${props.branch || 'Branch does not exist yet'})` : 'Gitgud';
  }

  updateStatus() {
    ipcRenderer.send('status');
  }

  toggleStageFile(file: FileStatus, stage: boolean) {
    ipcRenderer.send(stage ? 'stage' : 'unstage', file);
  }

  fileDiff(file: FileStatus, staged: boolean) {
    ipcRenderer.send('diff', file, staged);
  }

  renderFileStatus(file: FileStatus, isStaged: boolean) {
    return (
      <li className={'App_stageView_pane_file'}>
        <label className={'App_stageView_pane_file_select'}>
          <input type="radio" name="selected" onClick={() => this.fileDiff(file, isStaged)} value={file.path}/> {file.path}
        </label>
        <button className={'App_stageView_pane_file_action'} onClick={() => this.toggleStageFile(file, !isStaged)}>
          {isStaged ? 'Unstage' : 'Stage'}
        </button>
      </li>
    );
  }

  renderHunk(lines: LineDiff[], lineCount: number) {
    return (
      <div>
        {lines[0].lineNumbers[1] > 1 &&
          <div className={'App_diffView_line'}>
            <span className={'App_diffView_line_number'} data-line-number={'...'}/>
            <span className={'App_diffView_line_number'} data-line-number={'...'}/>
          </div>
        }
        {lines.map((line) => {
          return <div className={$(
            'App_diffView_line',
            { 'App_diffView_line-addition': line.type === '+', 'App_diffView_line-removal': line.type === '-' },
          )}>
            <span className={'App_diffView_line_number'} data-line-number={line.type !== '+' ? line.lineNumbers[0] : ''}/>
            <span className={'App_diffView_line_number'} data-line-number={line.type !== '-' ? line.lineNumbers[1] : ''}/>
            <span className={'App_diffView_line_type'} data-line-number={line.type}/>
            <pre className={'App_diffView_line_text'}>{line.text}</pre>
          </div>;
        })}
      </div>
    );
  }

  render() {
    const unstagedFiles = this.props.files.filter((file) => file.status & ~IS_STAGED);
    const stagedFiles = this.props.files.filter((file) => file.status & IS_STAGED);

    const hunks = parsePatch(this.props.diff || '');
    const finalLine = last(hunks) && last(last(hunks));
    console.log(finalLine, this.props.lineCount);

    return (
      <div className={'App'}>
        <div className={'App_titlebar'}>
          <h1 className={'App_titlebar_title'}>
            {this.getTitle(this.props)} <button className={'App_titlebar_refresh'} onClick={() => this.updateStatus()}>Refresh</button>
          </h1>
        </div>
        <div className={'App_stageView'}>
          <div className={'App_stageView_pane App_stageView_pane-unstaged'}>
            <h2 className={'App_stageView_pane_title'}>Unstaged changes</h2>
            <ul className={'App_stageView_pane_content'}>
              {unstagedFiles.map((file) => this.renderFileStatus(file, false))}
            </ul>
          </div>
          <div className={'App_stageView_pane App_stageView_pane-staged'}>
            <h2 className={'App_stageView_pane_title'}>Staged changes</h2>
            <ul className={'App_stageView_pane_content'}>
              {stagedFiles.map((file) => this.renderFileStatus(file, true))}
            </ul>
          </div>
        </div>
        <div className={'App_diffView'}>
          {hunks.map((hunk) => this.renderHunk(hunk, this.props.lineCount))}
          {finalLine && finalLine.lineNumbers[1] < this.props.lineCount &&
            <div className={'App_diffView_line'}>
              <span className={'App_diffView_line_number'} data-line-number={'...'}/>
              <span className={'App_diffView_line_number'} data-line-number={'...'}/>
            </div>
          }
        </div>
      </div>
    );
  }
}

const AppContainer = connect(App, (store: Store): AppStoreProps => {
  return {
    name: store.name || '',
    branch: store.branch || '',
    files: store.status.files,
    diff: store.diff,
    lineCount: store.lineCount,
  };
});

function lookupKey<Keys extends string>(value: string, keys: Keys[], defaultKey: Keys) {
  return keys.find((key) => key === value) || defaultKey;
}

// Takes a list of lines from a Git patch diff and returns a list of hunks with line indexes
function parsePatchHunks(lines: string[]): Hunk[] {
  return lines.map((line, index) => {
    const match = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);
    const lineNumbers = match ? match.slice(1, 5) : undefined;
    return { index: index, lineNumbers: lineNumbers };
  })
  .filter((hunk): hunk is Hunk => Boolean(hunk.lineNumbers));
}

// Parses a Git patch diff and returns diff information per line, per hunk
function parsePatch(patch: string): LineDiff[][] {
  const lines = patch.split('\n');
  return parsePatchHunks(lines)
  .map((hunk, i, indexes) => {
    const rangeStart = hunk.index + 1;
    const rangeEnd = indexes[i + 1] ? indexes[i + 1].index : lines.length - 1;
    const lineNumbers = [Number(hunk.lineNumbers[0]) - 1, Number(hunk.lineNumbers[2]) - 1];

    return lines.slice(rangeStart, rangeEnd).map((line): LineDiff => {
      const type = lookupKey(line[0], ['+', '-', ' '], ' ');
      if (type !== '+') {
        lineNumbers[0]++;
      }
      if (type !== '-') {
        lineNumbers[1]++;
      }
      return { type: type, text: line.slice(1), lineNumbers: [lineNumbers[0], lineNumbers[1]] };
    });
  });
}

const appStore = createStore(reducer, applyMiddleware(thunk));
const app = document.getElementById('app');
ReactDOM.render(
  <Provider store={appStore}>
    <AppContainer/>
  </Provider>,
  app,
);
