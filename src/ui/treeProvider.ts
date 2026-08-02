import * as vscode from 'vscode';
import { NovelProject } from '../model/project';
import { Chapter } from '../model/types';

type GroupId = 'chapters' | 'characters' | 'lore' | 'summaries';

export class NovelNode extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: 'group' | 'chapter' | 'file' | 'hint',
    public readonly groupId?: GroupId,
    public readonly chapterOrder?: number
  ) {
    super(label, collapsibleState);
  }
}

/**
 * 侧边栏树：章节 / 角色 / 设定 / 摘要 四组。
 * 章节节点带摘要新鲜度徽标：⚠ 表示摘要缺失或已过期。
 */
export class NovelTreeProvider implements vscode.TreeDataProvider<NovelNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<NovelNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** 缓存过期章节序号，供 getChildren 打徽标用。 */
  private staleOrders = new Set<number>();

  constructor(private readonly project: NovelProject) {}

  refresh(): void {
    this.project.invalidate();
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: NovelNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: NovelNode): Promise<NovelNode[]> {
    if (!(await this.project.isInitialized())) {
      return [];
    }
    if (!element) {
      return this.rootGroups();
    }
    if (element.kind !== 'group' || !element.groupId) {
      return [];
    }

    switch (element.groupId) {
      case 'chapters':
        return this.chapterNodes();
      case 'characters':
        return this.characterNodes();
      case 'lore':
        return this.loreNodes();
      case 'summaries':
        return this.summaryNodes();
    }
  }

  private async rootGroups(): Promise<NovelNode[]> {
    const chapters = await this.project.listChapters();
    const stale = await this.project.staleChapters();
    this.staleOrders = new Set(stale.map((c) => c.order));

    const totalWords = chapters.reduce((sum, c) => sum + c.wordCount, 0);
    const characters = await this.project.listCharacters();
    const lore = await this.project.listLore();

    const chaptersNode = this.group('章节', 'chapters', `${chapters.length} 章 · ${formatWords(totalWords)}`);
    if (this.staleOrders.size > 0) {
      chaptersNode.description = `${chaptersNode.description} · ${this.staleOrders.size} 章待总结`;
      chaptersNode.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    }

    return [
      chaptersNode,
      this.group('角色', 'characters', `${characters.length} 人`),
      this.group('设定', 'lore', `${lore.length} 条`),
      this.group('摘要', 'summaries', this.staleOrders.size > 0 ? `${this.staleOrders.size} 章过期` : '已同步'),
    ];
  }

  private group(label: string, id: GroupId, description: string): NovelNode {
    const node = new NovelNode(label, vscode.TreeItemCollapsibleState.Expanded, 'group', id);
    node.description = description;
    node.contextValue = `group:${id}`;
    node.iconPath = new vscode.ThemeIcon(GROUP_ICONS[id]);
    return node;
  }

  private async chapterNodes(): Promise<NovelNode[]> {
    const chapters = await this.project.listChapters();
    if (chapters.length === 0) {
      return [this.hint('还没有章节，点上方 + 新建', 'novel.newChapter')];
    }
    return chapters.map((c) => this.chapterNode(c));
  }

  private chapterNode(chapter: Chapter): NovelNode {
    const stale = this.staleOrders.has(chapter.order);
    const node = new NovelNode(
      `${String(chapter.order).padStart(3, '0')} ${chapter.title}`,
      vscode.TreeItemCollapsibleState.None,
      'chapter',
      'chapters',
      chapter.order
    );
    node.description = `${formatWords(chapter.wordCount)}${stale ? ' ⚠' : ''}`;
    node.tooltip = new vscode.MarkdownString(
      [
        `**${chapter.title}**`,
        '',
        `- 文件：\`${chapter.relPath}\``,
        `- 字数：${chapter.wordCount}`,
        `- 摘要：${stale ? '⚠ 缺失或已过期' : '✓ 最新'}`,
      ].join('\n')
    );
    node.contextValue = 'chapter';
    node.resourceUri = vscode.Uri.joinPath(this.project.root, chapter.relPath);
    node.iconPath = new vscode.ThemeIcon(stale ? 'circle-outline' : 'circle-filled');
    node.command = {
      command: 'novel.openFile',
      title: '打开',
      arguments: [chapter.relPath],
    };
    return node;
  }

  private async characterNodes(): Promise<NovelNode[]> {
    const cards = await this.project.listCharacters();
    if (cards.length === 0) {
      return [this.hint('还没有角色卡，可运行「提取/更新角色卡」', 'novel.extractCharacters')];
    }
    return cards.map((card) => {
      const node = this.fileNode(card.name, card.relPath, 'characters');
      const bits = [...card.tags];
      if (card.aliases.length > 0) {
        bits.push(`别名 ${card.aliases.join('/')}`);
      }
      node.description = bits.join(' · ');
      node.iconPath = new vscode.ThemeIcon('person');
      return node;
    });
  }

  private async loreNodes(): Promise<NovelNode[]> {
    const entries = await this.project.listLore();
    if (entries.length === 0) {
      return [this.hint('还没有设定条目', 'novel.newLore')];
    }
    return entries.map((entry) => {
      const node = this.fileNode(entry.title, entry.relPath, 'lore');
      node.description = entry.keywords.join('/');
      node.iconPath = new vscode.ThemeIcon('globe');
      return node;
    });
  }

  private async summaryNodes(): Promise<NovelNode[]> {
    const nodes: NovelNode[] = [];
    const globalNode = this.fileNode('全书摘要', this.project.relPath(this.project.globalSummaryUri), 'summaries');
    globalNode.iconPath = new vscode.ThemeIcon('book');
    const manifest = await this.project.readManifest();
    const chapters = await this.project.listChapters();
    const latest = chapters.length > 0 ? chapters[chapters.length - 1].order : 0;
    const through = manifest.globalSummaryThrough ?? 0;
    globalNode.description = through > 0 ? `覆盖至第 ${through} 章${through < latest ? ' ⚠' : ''}` : '未生成';
    nodes.push(globalNode);

    nodes.push(this.fileNode('文风指南', this.project.relPath(this.project.styleUri), 'summaries', 'symbol-color'));
    nodes.push(this.fileNode('全书大纲', this.project.relPath(this.project.outlineUri), 'summaries', 'list-tree'));

    for (const chapter of chapters) {
      const summary = await this.project.readSummary(chapter.order);
      const node = new NovelNode(
        `${String(chapter.order).padStart(3, '0')} ${chapter.title}`,
        vscode.TreeItemCollapsibleState.None,
        'file',
        'summaries',
        chapter.order
      );
      if (!summary) {
        node.description = '未生成';
        node.iconPath = new vscode.ThemeIcon('circle-outline');
        node.command = { command: 'novel.summarizeChapter', title: '总结', arguments: [chapter.order] };
      } else {
        const stale = summary.sourceHash !== chapter.contentHash;
        node.description = stale ? '⚠ 已过期' : '✓';
        node.iconPath = new vscode.ThemeIcon(stale ? 'warning' : 'check');
        node.command = { command: 'novel.openFile', title: '打开', arguments: [summary.relPath] };
      }
      nodes.push(node);
    }
    return nodes;
  }

  private fileNode(label: string, relPath: string, groupId: GroupId, icon = 'file'): NovelNode {
    const node = new NovelNode(label, vscode.TreeItemCollapsibleState.None, 'file', groupId);
    node.contextValue = 'file';
    node.resourceUri = vscode.Uri.joinPath(this.project.root, relPath);
    node.iconPath = new vscode.ThemeIcon(icon);
    node.command = { command: 'novel.openFile', title: '打开', arguments: [relPath] };
    return node;
  }

  private hint(label: string, command: string): NovelNode {
    const node = new NovelNode(label, vscode.TreeItemCollapsibleState.None, 'hint');
    node.iconPath = new vscode.ThemeIcon('lightbulb');
    node.command = { command, title: label };
    return node;
  }
}

const GROUP_ICONS: Record<GroupId, string> = {
  chapters: 'book',
  characters: 'organization',
  lore: 'globe',
  summaries: 'list-flat',
};

function formatWords(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
}
