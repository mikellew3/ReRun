from conftest import make_play, pass_play

from common.plays import add_flags, add_pace, red_zone_drives
from fit_team_params import signed_streak, team_games


def test_play_flags(frame):
    df = add_flags(
        frame(
            [
                pass_play(complete_pass=1, yards_gained=25),
                pass_play(incomplete_pass=1),
                pass_play(sack=1, yards_gained=-7),
                pass_play(interception=1),
                make_play(
                    play_type="run", qb_dropback=1, qb_scramble=1, passer_id="QB1", yards_gained=6
                ),
                make_play(play_type="run", rusher_player_id="RB1", yards_gained=12),
                make_play(play_type="run", qb_kneel=1),
                pass_play(qb_spike=1, incomplete_pass=1),
                pass_play(two_point_attempt=1, complete_pass=1),
            ]
        )
    )
    assert df["is_dropback"].tolist() == [True, True, True, True, True, False, False, False, False]
    assert df["is_attempt"].tolist() == [True, True, False, True, False, False, False, False, False]
    assert df["is_complete"].sum() == 1
    assert df["is_sack"].sum() == 1
    assert df["is_scramble"].sum() == 1
    assert df["is_int"].sum() == 1
    assert df["is_designed_run"].tolist() == [False] * 5 + [True, False, False, False]
    assert df["is_explosive_pass"].iloc[0]
    assert df["is_explosive_run"].iloc[5]


def test_red_zone_drives(frame):
    df = add_flags(
        frame(
            [
                make_play(fixed_drive=1, yardline_100=30, fixed_drive_result="Touchdown"),
                make_play(fixed_drive=1, yardline_100=15, fixed_drive_result="Touchdown"),
                make_play(fixed_drive=2, yardline_100=50, fixed_drive_result="Punt"),
                make_play(fixed_drive=3, yardline_100=18, fixed_drive_result="Field goal"),
            ]
        )
    )
    rz = red_zone_drives(df)
    assert len(rz) == 2
    assert rz["td"].sum() == 1


def test_pace_counts_only_running_clock_gaps(frame):
    df = add_flags(
        frame(
            [
                make_play(play_id=1, game_seconds_remaining=3600),
                make_play(play_id=2, game_seconds_remaining=3565),  # 35s, clock ran
                pass_play(play_id=3, game_seconds_remaining=3530, incomplete_pass=1),
                make_play(play_id=4, game_seconds_remaining=3524),  # after incompletion: not pace
                make_play(play_id=5, game_seconds_remaining=3400),  # 124s gap: too long
            ]
        )
    )
    gaps = add_pace(df)["pace_gap"].tolist()
    assert gaps[1] == 35 and gaps[2] == 35
    assert all(g != g for g in [gaps[0], gaps[3], gaps[4]])  # NaN


def test_team_games_counts(frame):
    rows = [
        pass_play(play_id=1, complete_pass=1, yards_gained=8, epa=0.5),
        pass_play(play_id=2, sack=1, yards_gained=-6, epa=-1.0),
        make_play(play_id=3, rusher_player_id="RB1", yards_gained=4, epa=0.1),
        make_play(play_id=4, posteam="BBB", defteam="AAA", rusher_player_id="RB2", yards_gained=3),
    ]
    df = add_pace(add_flags(frame(rows)))
    g = team_games(df).set_index("off")
    assert g.loc["AAA", "dropbacks"] == 2
    assert g.loc["AAA", "sacks"] == 1
    assert g.loc["AAA", "attempts"] == 1
    assert g.loc["AAA", "comp_yds"] == 8
    assert g.loc["AAA", "runs"] == 1
    assert g.loc["AAA", "pass_epa"] == -0.5
    assert g.loc["BBB", "def"] == "AAA"


def test_signed_streak():
    assert signed_streak([1, 1, -1]) == 2
    assert signed_streak([-1, -1, -1, 1]) == -3
    assert signed_streak([0, 1]) == 0
    assert signed_streak([]) == 0
