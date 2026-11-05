use agent_stacks_escrow::game::{self, Game};
use serde_json::Value;
use std::{path::PathBuf, process::Command};
fn pair(v: &Value) -> [u64; 2] {
    [v[0].as_u64().unwrap(), v[1].as_u64().unwrap()]
}
fn assert_state(g: &Game, v: &Value) {
    assert_eq!(g.stacks, pair(&v["stacks"]));
    assert_eq!(g.bets, pair(&v["bets"]));
    assert_eq!(g.contributed, pair(&v["contributed"]));
    assert_eq!(g.current_bet, v["currentBet"].as_u64().unwrap());
    assert_eq!(g.min_raise, v["minRaise"].as_u64().unwrap());
    assert_eq!(g.actor as u64, v["actor"].as_u64().unwrap());
    assert_eq!(g.street as u64, v["street"].as_u64().unwrap());
    assert_eq!(g.stage as u64, v["stage"].as_u64().unwrap());
    let board: Vec<u8> = v["board"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_u64().unwrap() as u8)
        .collect();
    assert_eq!(g.board.as_slice(), board);
    assert_eq!(Game::decode(&g.encode()).unwrap(), *g);
}
#[test]
fn javascript_differential_rankings_and_randomized_betting_traces() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let result = Command::new("node")
        .current_dir(root)
        .arg("scripts/poker-vectors.js")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let data: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(
        hex::encode(agent_stacks_escrow::cards::INITIAL_DECK),
        data["initialDeckHex"].as_str().unwrap()
    );
    for rank in data["ranks"].as_array().unwrap() {
        let cards: Vec<u8> = rank["cards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as u8)
            .collect();
        let expected: Vec<u8> = rank["score"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as u8)
            .collect();
        assert_eq!(game::evaluate(&cards).unwrap().as_slice(), expected);
    }
    for case in data["games"].as_array().unwrap() {
        let mut g = Game::new(
            pair(&case["stacks"]),
            case["bb"].as_u64().unwrap(),
            case["button"].as_u64().unwrap() as u8,
        )
        .unwrap();
        assert_state(&g, &case["initial"]);
        for step in case["steps"].as_array().unwrap() {
            match step["kind"].as_str().unwrap() {
                "action" => g
                    .act(
                        step["seat"].as_u64().unwrap() as u8,
                        step["action"].as_u64().unwrap() as u8,
                        step["amount"].as_u64().unwrap(),
                    )
                    .unwrap(),
                "board" => {
                    let start = if g.street == 1 {
                        0
                    } else if g.street == 2 {
                        3
                    } else {
                        4
                    };
                    for (i, c) in step["cards"].as_array().unwrap().iter().enumerate() {
                        g.board[start + i] = c.as_u64().unwrap() as u8;
                    }
                    g.resume_board().unwrap();
                }
                "showdown" => {
                    for s in 0..2 {
                        for i in 0..2 {
                            g.holes[s][i] = step["holes"][s][i].as_u64().unwrap() as u8;
                        }
                    }
                    g.showdown().unwrap();
                }
                _ => panic!("unknown step"),
            }
            assert_state(&g, &step["expected"]);
        }
    }
}

#[test]
fn channel_engine_matches_the_contract_byte_for_byte() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let result = Command::new("node")
        .current_dir(root)
        .arg("scripts/channel-game-vectors.js")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let data: Value = serde_json::from_slice(&result.stdout).unwrap();
    let cards = |v: &Value| -> Vec<u8> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_u64().unwrap() as u8)
            .collect()
    };
    for rank in data["ranks"].as_array().unwrap() {
        assert_eq!(
            game::evaluate(&cards(&rank["cards"])).unwrap().to_vec(),
            cards(&rank["score"])
        );
    }
    let (mut moves, mut refused) = (0, 0);
    for case in data["games"].as_array().unwrap() {
        let mut g = Game::new(
            pair(&case["stacks"]),
            case["bb"].as_u64().unwrap(),
            case["button"].as_u64().unwrap() as u8,
        )
        .unwrap();
        for s in 0..2 {
            let hole = cards(&case["holes"][s]);
            g.holes[s] = [hole[0], hole[1]];
        }
        assert_eq!(hex::encode(g.encode()), case["initial"].as_str().unwrap());
        for step in case["steps"].as_array().unwrap() {
            match step["kind"].as_str().unwrap() {
                "act" => {
                    let mut copy = g.clone();
                    let outcome = copy.act(
                        step["seat"].as_u64().unwrap() as u8,
                        step["action"].as_u64().unwrap() as u8,
                        step["amount"].as_u64().unwrap(),
                    );
                    assert_eq!(outcome.is_ok(), step["ok"].as_bool().unwrap(), "{step}");
                    if outcome.is_ok() {
                        g = copy;
                        moves += 1;
                    } else {
                        refused += 1;
                        continue;
                    }
                }
                "board" => {
                    let start = match g.street {
                        1 => 0,
                        2 => 3,
                        _ => 4,
                    };
                    for (i, c) in cards(&step["cards"]).iter().enumerate() {
                        g.board[start + i] = *c;
                    }
                    g.resume_board().unwrap();
                }
                "showdown" => g.showdown().unwrap(),
                _ => panic!("unknown step"),
            }
            assert_eq!(hex::encode(g.encode()), step["after"].as_str().unwrap());
        }
    }
    assert!(
        moves > 2000 && refused > 20,
        "traces too thin: {moves} moves, {refused} refused"
    );
}

#[test]
fn next_hand_preserves_winnings_resets_secrets_and_stops_at_limit_or_bust() {
    use agent_stacks_escrow::{cards, play, DECK_OFFSET};
    let mut state = vec![0u8; play::SPACE];
    state[play::HAND..play::MAX_HANDS].copy_from_slice(&1u32.to_le_bytes());
    state[play::MAX_HANDS..play::SPACE].copy_from_slice(&3u32.to_le_bytes());
    state[play::BLIND_OFFSET..play::GAME_OFFSET].copy_from_slice(&20u64.to_le_bytes());
    state[137..201].fill(7);
    state[play::SHARES_OFFSET..=play::CURSOR].fill(9);
    let mut g = Game::new([1000; 2], 20, 0).unwrap();
    g.act(0, 0, 0).unwrap(); // Button folds: only matched blind transfers.
    let awarded = g.stacks;
    play::write(&mut state, &g);
    assert!(play::next_hand(&mut state).unwrap());
    let next = play::read(&state).unwrap();
    assert_eq!(play::hand(&state), 2);
    assert_eq!(next.button, 1);
    for (seat, stack) in awarded.iter().enumerate() {
        assert_eq!(next.stacks[seat] + next.contributed[seat], *stack);
    }
    assert_eq!(&state[137..201], &[0; 64]);
    assert_eq!(&state[play::SHARES_OFFSET..=play::CURSOR], &[0; 577]);
    assert_eq!(&state[DECK_OFFSET..play::DECK_END], &cards::INITIAL_DECK);
    assert_eq!(next.holes, [[game::NONE; 2]; 2]);
    assert_eq!(state[8], 1);
    // Once the hand limit is reached, or a player is busted, custody settles.
    let mut end = g.clone();
    end.stacks = [0, 2000];
    play::write(&mut state, &end);
    assert!(!play::next_hand(&mut state).unwrap());
    end.stacks = [1000; 2];
    play::write(&mut state, &end);
    state[play::HAND..play::MAX_HANDS].copy_from_slice(&3u32.to_le_bytes());
    assert!(!play::next_hand(&mut state).unwrap());
}

#[test]
fn carried_stack_can_exceed_one_buy_in_ceiling() {
    // Creation allows 1e12 per player; winnings can carry nearly 2e12.
    let g = Game::new([1_500_000_000_000, 500_000_000_000], 100_000_000_000, 1).unwrap();
    assert_eq!(
        g.stacks.iter().sum::<u64>() + g.contributed.iter().sum::<u64>(),
        2_000_000_000_000
    );
}

#[test]
fn exhaustive_five_card_categories_match_independent_combinatorial_counts() {
    let mut counts = [0u64; 9];
    for a in 0..48 {
        for b in a + 1..49 {
            for c in b + 1..50 {
                for d in c + 1..51 {
                    for e in d + 1..52 {
                        counts[game::evaluate(&[a, b, c, d, e]).unwrap()[0] as usize] += 1;
                    }
                }
            }
        }
    }
    // Counts derive from rank/suit combinations, not the JavaScript evaluator.
    assert_eq!(
        counts,
        [1_302_540, 1_098_240, 123_552, 54_912, 10_200, 5_108, 3_744, 624, 40]
    );
    assert_eq!(counts.iter().sum::<u64>(), 2_598_960);
}

#[test]
fn seven_card_rankings_match_a_direct_histogram_oracle() {
    fn straight(ranks: &[u8]) -> u8 {
        (5..=14)
            .rev()
            .find(|&high| {
                (0..5).all(|i| ranks.contains(&(if high == 5 && i == 4 { 14 } else { high - i })))
            })
            .unwrap_or(0)
    }
    fn oracle(cards: &[u8; 7]) -> [u8; 6] {
        let mut counts = [0u8; 15];
        for c in cards {
            counts[(c / 4 + 2) as usize] += 1;
        }
        let ranks: Vec<u8> = (2..=14).rev().filter(|r| counts[*r as usize] > 0).collect();
        let flush = (0..4)
            .map(|s| {
                cards
                    .iter()
                    .filter(|c| **c % 4 == s)
                    .map(|c| c / 4 + 2)
                    .collect::<Vec<u8>>()
            })
            .find(|r| r.len() >= 5);
        let n = |count| {
            ranks
                .iter()
                .copied()
                .filter(|r| counts[*r as usize] >= count)
                .collect::<Vec<_>>()
        };
        let make = |cat, kickers: &[u8]| {
            let mut out = [0; 6];
            out[0] = cat;
            out[1..1 + kickers.len()].copy_from_slice(kickers);
            out
        };
        if let Some(ref suited) = flush {
            let high = straight(suited);
            if high > 0 {
                return make(8, &[high]);
            }
        }
        let quads = n(4);
        if !quads.is_empty() {
            return make(
                7,
                &[quads[0], *ranks.iter().find(|r| **r != quads[0]).unwrap()],
            );
        }
        let trips = n(3);
        let pairs = n(2);
        if !trips.is_empty() {
            if let Some(pair) = pairs.iter().find(|r| **r != trips[0]) {
                return make(6, &[trips[0], *pair]);
            }
        }
        if let Some(mut suited) = flush {
            suited.sort_unstable_by(|a, b| b.cmp(a));
            return make(5, &suited[..5]);
        }
        let high = straight(&ranks);
        if high > 0 {
            return make(4, &[high]);
        }
        if !trips.is_empty() {
            let mut k = vec![trips[0]];
            k.extend(ranks.iter().copied().filter(|r| *r != trips[0]).take(2));
            return make(3, &k);
        }
        if pairs.len() >= 2 {
            return make(
                2,
                &[
                    pairs[0],
                    pairs[1],
                    *ranks
                        .iter()
                        .find(|r| **r != pairs[0] && **r != pairs[1])
                        .unwrap(),
                ],
            );
        }
        if !pairs.is_empty() {
            let mut k = vec![pairs[0]];
            k.extend(ranks.iter().copied().filter(|r| *r != pairs[0]).take(3));
            return make(1, &k);
        }
        make(0, &ranks[..5])
    }
    let mut rng = 0x4a53_706f_6b65_7231u64;
    for _ in 0..10_000 {
        let mut cards = [0u8; 7];
        for i in 0..7 {
            loop {
                rng ^= rng << 13;
                rng ^= rng >> 7;
                rng ^= rng << 17;
                let c = (rng % 52) as u8;
                if !cards[..i].contains(&c) {
                    cards[i] = c;
                    break;
                }
            }
        }
        assert_eq!(game::evaluate(&cards).unwrap(), oracle(&cards), "{cards:?}");
    }
}
