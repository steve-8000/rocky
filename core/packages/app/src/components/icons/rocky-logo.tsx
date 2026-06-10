import Svg, { Path } from "react-native-svg";
import { useUnistyles } from "react-native-unistyles";

interface RockyLogoProps {
  size?: number;
  color?: string;
}

// Rocky mark — a faceted rock. Same geometry as the desktop app icon
// (scripts/brand/make-icons.py); facets are rendered as opacity steps of a
// single color so the mark works in any theme foreground/accent color.
export function RockyLogo({ size = 64, color }: RockyLogoProps) {
  const { theme } = useUnistyles();
  const fill = color ?? theme.colors.foreground;

  const facets: Array<{ d: string; opacity: number }> = [
    // top-right
    { d: "M50 16 L78 34 L50 50 Z", opacity: 0.92 },
    // top-left
    { d: "M50 16 L22 34 L50 50 Z", opacity: 1 },
    // left
    { d: "M22 34 L18 66 L50 50 Z", opacity: 0.78 },
    // right
    { d: "M78 34 L82 66 L50 50 Z", opacity: 0.6 },
    // bottom-left
    { d: "M18 66 L50 84 L50 50 Z", opacity: 0.88 },
    // bottom-right
    { d: "M82 66 L50 84 L50 50 Z", opacity: 0.48 },
  ];

  return (
    <Svg width={size} height={size} viewBox="0 0 100 100" fill="none">
      {facets.map((f) => (
        <Path key={f.d} d={f.d} fill={fill} fillOpacity={f.opacity} />
      ))}
    </Svg>
  );
}
