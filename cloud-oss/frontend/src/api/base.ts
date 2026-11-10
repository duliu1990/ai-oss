// Web builds are served by the backend and stay same-origin; native builds bake in the backend origin.
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? '';
