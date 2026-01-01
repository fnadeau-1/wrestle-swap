module.exports = {
  parserOptions: {
    ecmaVersion: 2018,
  },
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
  ],
  rules: {
    // Disable all spacing rules
    "object-curly-spacing": "off",
    "no-multi-spaces": "off",
    "quotes": "off",
    "indent": "off",
  },
};