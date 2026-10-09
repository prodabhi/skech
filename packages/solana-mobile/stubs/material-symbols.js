// expo-router's native tabs reach Material Symbols through expo-symbols, which loads every weight of the font
// (about 3 MB). skech uses neither, so the import resolves here: no fonts, and a useFonts that says they loaded.
export const useFonts = () => [true, null]
