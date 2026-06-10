import Svg, { Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";

interface RockyLogoProps {
  size?: number;
  color?: string;
}

// Rocky mark — an asymmetric faceted peak. Same geometry as the desktop app
// icon (scripts/brand/make-icons.py); facets are rendered as opacity steps of
// a single color so the mark works in any theme foreground/accent color.
// Silhouette: apex (44,10) → right shoulder (74,32) → right base (88,74)
// → base (58,88) → base-left (14,80) → left shoulder (22,44) → apex.
export function RockyLogo({ size = 64, color }: RockyLogoProps) {
  const { theme } = useUnistyles();
  const fill = color ?? theme.colors.foreground;

  const facets: Array<{ d: string; opacity: number }> = [
    // apex, left face (highlight)
    { d: "M44 10 L22 44 L48 54 Z", opacity: 1 },
    // apex, right face
    { d: "M44 10 L48 54 L74 32 Z", opacity: 0.85 },
    // left flank
    { d: "M22 44 L14 80 L48 54 Z", opacity: 0.9 },
    // bottom-left
    { d: "M48 54 L14 80 L58 88 Z", opacity: 0.72 },
    // right flank
    { d: "M74 32 L48 54 L88 74 Z", opacity: 0.62 },
    // bottom-right
    { d: "M48 54 L88 74 L58 88 Z", opacity: 0.48 },
  ];

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      {facets.map((f) => (
        <Path key={f.d} d={f.d} fill={fill} fillOpacity={f.opacity} />
      ))}
    </Svg>
  );
}
