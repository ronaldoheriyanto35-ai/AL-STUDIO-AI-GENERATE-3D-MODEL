// Konfigurasi sisi browser. File ini aman di-commit (bukan rahasia).
// Rahasia (ANTHROPIC_API_KEY) hanya ada di server, lewat Environment Variables.
window.LUAULAB_CONFIG = {
  // Kosongkan bila web dan server ada di alamat yang sama (kasus Render).
  apiUrl: "",
  // Web app Firebase (Project settings > Your apps > Web).
  // Kosongkan untuk mode demo: login hanya disimpan di perangkat.
  firebase: {
    apiKey: "",
    authDomain: "",
    projectId: "",
    appId: ""
  }
};
