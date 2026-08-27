import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import type { AppLanguage } from "./gateway-runtime";

export interface MenuTranslation {
  file: string;
  settings: string;
  close_window: string;
  quit: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  select_all: string;
  view: string;
  reload: string;
  force_reload: string;
  toggle_devtools: string;
  actual_size: string;
  zoom_in: string;
  zoom_out: string;
  toggle_fullscreen: string;
  window: string;
  minimize: string;
  zoom: string;
  bring_all_to_front: string;
  help: string;
  check_updates: string;
  send_feedback: string;
  about: string;
  show_app: string;
  retry_gateway: string;
  status_label: string;
  gateway_running: string;
  gateway_starting: string;
  gateway_stopped: string;
  gateway_error: string;
}

export const MENU_STRINGS: Record<AppLanguage, MenuTranslation> = {
  en: {
    file: "File",
    settings: "Settings",
    close_window: "Close Window",
    quit: "Quit",
    edit: "Edit",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    view: "View",
    reload: "Reload",
    force_reload: "Force Reload",
    toggle_devtools: "Toggle Developer Tools",
    actual_size: "Actual Size",
    zoom_in: "Zoom In",
    zoom_out: "Zoom Out",
    toggle_fullscreen: "Toggle Full Screen",
    window: "Window",
    minimize: "Minimize",
    zoom: "Zoom",
    bring_all_to_front: "Bring All to Front",
    help: "Help",
    check_updates: "Check for Updates…",
    send_feedback: "Send Feedback…",
    about: "About NVIDIA Gateway",
    show_app: "Show App",
    retry_gateway: "Retry Gateway",
    status_label: "Status",
    gateway_running: "Running",
    gateway_starting: "Starting",
    gateway_stopped: "Stopped",
    gateway_error: "Error"
  },
  ru: {
    file: "Файл",
    settings: "Настройки",
    close_window: "Закрыть окно",
    quit: "Выход",
    edit: "Правка",
    undo: "Отменить",
    redo: "Повторить",
    cut: "Вырезать",
    copy: "Копировать",
    paste: "Вставить",
    select_all: "Выделить всё",
    view: "Вид",
    reload: "Перезагрузить",
    force_reload: "Принудительная перезагрузка",
    toggle_devtools: "Инструменты разработчика",
    actual_size: "Исходный размер",
    zoom_in: "Увеличить",
    zoom_out: "Уменьшить",
    toggle_fullscreen: "Полноэкранный режим",
    window: "Окно",
    minimize: "Свернуть",
    zoom: "Развернуть",
    bring_all_to_front: "Все окна — на передний план",
    help: "Справка",
    check_updates: "Проверить обновления…",
    send_feedback: "Отправить отзыв…",
    about: "О программе NVIDIA Gateway",
    show_app: "Показать окно",
    retry_gateway: "Перезапустить шлюз",
    status_label: "Состояние",
    gateway_running: "Работает",
    gateway_starting: "Запускается",
    gateway_stopped: "Остановлен",
    gateway_error: "Ошибка"
  },
  zh: {
    file: "文件",
    settings: "设置",
    close_window: "关闭窗口",
    quit: "退出",
    edit: "编辑",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    select_all: "全选",
    view: "视图",
    reload: "重新加载",
    force_reload: "强制重新加载",
    toggle_devtools: "开发者工具",
    actual_size: "实际大小",
    zoom_in: "放大",
    zoom_out: "缩小",
    toggle_fullscreen: "切换全屏",
    window: "窗口",
    minimize: "最小化",
    zoom: "最大化",
    bring_all_to_front: "前置所有窗口",
    help: "帮助",
    check_updates: "检查更新…",
    send_feedback: "发送反馈…",
    about: "关于 NVIDIA Gateway",
    show_app: "显示窗口",
    retry_gateway: "重试网关",
    status_label: "状态",
    gateway_running: "运行中",
    gateway_starting: "启动中",
    gateway_stopped: "已停止",
    gateway_error: "错误"
  },
  es: {
    file: "Archivo",
    settings: "Configuración",
    close_window: "Cerrar ventana",
    quit: "Salir",
    edit: "Edición",
    undo: "Deshacer",
    redo: "Rehacer",
    cut: "Cortar",
    copy: "Copiar",
    paste: "Pegar",
    select_all: "Seleccionar todo",
    view: "Ver",
    reload: "Recargar",
    force_reload: "Forzar recarga",
    toggle_devtools: "Herramientas de desarrollo",
    actual_size: "Tamaño real",
    zoom_in: "Acercar",
    zoom_out: "Alejar",
    toggle_fullscreen: "Pantalla completa",
    window: "Ventana",
    minimize: "Minimizar",
    zoom: "Maximizar",
    bring_all_to_front: "Traer todo al frente",
    help: "Ayuda",
    check_updates: "Buscar actualizaciones…",
    send_feedback: "Enviar comentarios…",
    about: "Acerca de NVIDIA Gateway",
    show_app: "Mostrar aplicación",
    retry_gateway: "Reintentar puerta de enlace",
    status_label: "Estado",
    gateway_running: "En ejecución",
    gateway_starting: "Iniciando",
    gateway_stopped: "Detenida",
    gateway_error: "Error"
  },
  hi: {
    file: "फ़ाइल",
    settings: "सेटिंग्स",
    close_window: "विंडो बंद करें",
    quit: "बाहर निकलें",
    edit: "संपादित करें",
    undo: "पूर्ववत करें",
    redo: "पुनः करें",
    cut: "काटें",
    copy: "कॉपी करें",
    paste: "पेस्ट करें",
    select_all: "सभी चुनें",
    view: "देखें",
    reload: "पुनः लोड करें",
    force_reload: "बलपूर्वक पुनः लोड करें",
    toggle_devtools: "डेवलपर उपकरण",
    actual_size: "वास्तविक आकार",
    zoom_in: "ज़ूम इन",
    zoom_out: "ज़ूम आउट",
    toggle_fullscreen: "फ़ुलस्क्रीन टॉगल करें",
    window: "विंडो",
    minimize: "छोटा करें",
    zoom: "बड़ा करें",
    bring_all_to_front: "सभी को आगे लाएं",
    help: "मदद",
    check_updates: "अपडेट की जाँच करें…",
    send_feedback: "फ़ीडबैक भेजें…",
    about: "NVIDIA Gateway के बारे में",
    show_app: "ऐप दिखाएं",
    retry_gateway: "गेटवे पुनः प्रयास करें",
    status_label: "स्थिति",
    gateway_running: "चल रहा है",
    gateway_starting: "प्रारंभ हो रहा है",
    gateway_stopped: "बंद है",
    gateway_error: "त्रुटि"
  },
  fr: {
    file: "Fichier",
    settings: "Paramètres",
    close_window: "Fermer la fenêtre",
    quit: "Quitter",
    edit: "Édition",
    undo: "Annuler",
    redo: "Rétablir",
    cut: "Couper",
    copy: "Copier",
    paste: "Coller",
    select_all: "Tout sélectionner",
    view: "Affichage",
    reload: "Recharger",
    force_reload: "Forcer le rechargement",
    toggle_devtools: "Outils de développement",
    actual_size: "Taille réelle",
    zoom_in: "Zoom avant",
    zoom_out: "Zoom arrière",
    toggle_fullscreen: "Activer le plein écran",
    window: "Fenêtre",
    minimize: "Réduire",
    zoom: "Agrandir",
    bring_all_to_front: "Tout ramener au premier plan",
    help: "Aide",
    check_updates: "Vérifier les mises à jour…",
    send_feedback: "Envoyer un commentaire…",
    about: "À propos de NVIDIA Gateway",
    show_app: "Afficher l'application",
    retry_gateway: "Réessayer la passerelle",
    status_label: "État",
    gateway_running: "En cours d'exécution",
    gateway_starting: "Démarrage",
    gateway_stopped: "Arrêtée",
    gateway_error: "Erreur"
  },
  ar: {
    file: "ملف",
    settings: "الإعدادات",
    close_window: "إغلاق النافذة",
    quit: "إنهاء",
    edit: "تعديل",
    undo: "تراجع",
    redo: "إعادة",
    cut: "قص",
    copy: "نسخ",
    paste: "لصق",
    select_all: "تحديد الكل",
    view: "عرض",
    reload: "إعادة التحميل",
    force_reload: "فرض إعادة التحميل",
    toggle_devtools: "أدوات المطور",
    actual_size: "الحجم الفعلي",
    zoom_in: "تكبير",
    zoom_out: "تصغير",
    toggle_fullscreen: "ملء الشاشة",
    window: "نافذة",
    minimize: "تصغير",
    zoom: "تكبير",
    bring_all_to_front: "إحضار الكل للمقدمة",
    help: "مساعدة",
    check_updates: "التحقق من وجود تحديثات…",
    send_feedback: "إرسال ملاحظات…",
    about: "حول NVIDIA Gateway",
    show_app: "إظهار التطبيق",
    retry_gateway: "إعادة محاولة البوابة",
    status_label: "الحالة",
    gateway_running: "قيد التشغيل",
    gateway_starting: "جارٍ التشغيل",
    gateway_stopped: "متوقفة",
    gateway_error: "خطأ"
  }
};

export function getMenuStrings(language: AppLanguage): MenuTranslation {
  return MENU_STRINGS[language] ?? MENU_STRINGS.en;
}

export interface ApplicationMenuOptions {
  language: AppLanguage;
  onCheckUpdates?: () => void;
  onOpenSettings?: () => void;
}

export function buildApplicationMenu(options: ApplicationMenuOptions): Menu {
  const { language, onCheckUpdates, onOpenSettings } = options;
  const t = getMenuStrings(language);

  const template: MenuItemConstructorOptions[] = [
    {\r
      label: t.file,
      submenu: [
        ...(onOpenSettings
          ? [
              {
                label: t.settings,
                accelerator: "CmdOrCtrl+,",
                click: () => onOpenSettings()
              },
              { type: "separator" as const }
            ]
          : []),
        {
          label: t.close_window,
          role: "close"
        },
        { type: "separator" },
        {
          label: t.quit,
          accelerator: process.platform === "darwin" ? "Cmd+Q" : "Alt+F4",
          click: () => app.quit()
        }
      ]
    },
    {
      label: t.edit,
      submenu: [
        { label: t.undo, role: "undo" },
        { label: t.redo, role: "redo" },
        { type: "separator" },
        { label: t.cut, role: "cut" },
        { label: t.copy, role: "copy" },
        { label: t.paste, role: "paste" },
        { label: t.select_all, role: "selectAll" }
      ]
    },
    {
      label: t.view,
      submenu: [
        { label: t.reload, role: "reload" },
        { label: t.force_reload, role: "forceReload" },
        { label: t.toggle_devtools, role: "toggleDevTools" },
        { type: "separator" },
        { label: t.actual_size, role: "resetZoom" },
        { label: t.zoom_in, role: "zoomIn" },
        { label: t.zoom_out, role: "zoomOut" },
        { type: "separator" },
        { label: t.toggle_fullscreen, role: "togglefullscreen" }
      ]
    },
    {
      label: t.window,
      submenu: [
        { label: t.minimize, role: "minimize" },
        { label: t.zoom, role: "zoom" },
        ...(process.platform === "darwin"
          ? [
              { type: "separator" as const },
              { label: t.bring_all_to_front, role: "front" as const }
            ]
          : [])
      ]
    },
    {
      label: t.help,
      submenu: [
        ...(onCheckUpdates
          ? [
              {
                label: t.check_updates,
                click: () => onCheckUpdates()
              },
              { type: "separator" as const }
            ]
          : []),
        {
          label: t.send_feedback,
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow) {
              focusedWindow.webContents.send("navigate-feedback");
            }
          }
        },
        { type: "separator" as const },
        {
          label: t.about,
          click: () => {
            const focusedWindow = BrowserWindow.getFocusedWindow();
            if (focusedWindow) {
              focusedWindow.webContents.send("navigate-about");
            }
          }
        }
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

export function buildContextMenu(
  language: AppLanguage,
  params: {
    isEditable: boolean;
    editFlags: {
      canCut: boolean;
      canCopy: boolean;
      canPaste: boolean;
      canSelectAll: boolean;
    };
  }
): Menu {
  const t = getMenuStrings(language);

  return Menu.buildFromTemplate([
    {
      label: t.cut,
      role: "cut",
      enabled: params.editFlags.canCut,
      visible: params.isEditable
    },
    {
      label: t.copy,
      role: "copy",
      enabled: params.editFlags.canCopy
    },
    {
      label: t.paste,
      role: "paste",
      enabled: params.editFlags.canPaste,
      visible: params.isEditable
    },
    { type: "separator" },
    {
      label: t.select_all,
      role: "selectAll",
      enabled: params.editFlags.canSelectAll
    }
  ]);
}
