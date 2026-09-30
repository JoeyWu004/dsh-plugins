/**
 * 宿主半边（host half）。
 *
 * 本插件只贡献浏览器端展示：余额由宿主已有的 account Remote 提供，
 * 客户端半边通过 `exports["./client"]` 下发，因此宿主侧不需要任何行为。
 * 保留一个空的 apply 是为了让 loader 有一行可挂载的宿主插件。
 */

/** 宿主插件主体——本包不贡献宿主侧能力。 */
function apply() {}

export { apply }
