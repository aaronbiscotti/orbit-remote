namespace Orbit.Core;
public static class SetupProgress
{
    public static int CurrentStep(bool unlocked, bool accessAllowed) => !unlocked ? 0 : !accessAllowed ? 1 : 2;
}
