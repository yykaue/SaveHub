export const kinds = { manual: '手动存档', safety: '自动恢复点', imported: '导入存档' };
export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1073741824 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1073741824).toFixed(2)} GB`;
export const dateLabel = (value: string) => value ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '无法读取';
export const fullDate = (value: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
