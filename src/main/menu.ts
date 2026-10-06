import { Menu, shell, type MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '../shared/ipc';

/**
 * 应用菜单。
 *
 * 只有"文件"里的新建项需要回到渲染进程：连接树是渲染进程画的，主进程发命令即可。
 * 其余项沿用 Electron 的 role —— 自己手写会漏掉平台细节（剪贴板、缩放、重载路径）。
 *
 * 注意：设了应用菜单就会整体替换 Electron 默认菜单，所以"编辑/视图"必须显式保留，
 * 否则复制粘贴和 DevTools 会一起消失。
 */
export function installAppMenu(configDir: string, onCommand: (command: MenuCommand) => void): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新建连接…', accelerator: 'CmdOrCtrl+N', click: () => onCommand('new-session') },
        { label: '新建文件夹…', accelerator: 'CmdOrCtrl+Shift+N', click: () => onCommand('new-folder') },
        { type: 'separator' },
        { label: '打开配置目录', click: () => void shell.openPath(configDir) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}