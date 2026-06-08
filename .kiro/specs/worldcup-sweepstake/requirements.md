# Requirements Document

## Introduction

The World Cup Sweepstake is an internal tool that lets a team run a friendly competition around a World Cup tournament. Each participant is randomly assigned one or more competing nations. The tool tracks match results, maintains a points-based league table, and determines two prize winners: one for the participant whose assigned nation wins the World Cup, and one for the participant who accumulates the most points across the tournament. Points are awarded as 3 points for a win, 1 point for a draw, and 1 point for every goal scored by an assigned nation.

This document defines the functional requirements for the sweepstake tool. Implementation details (storage, UI framework, hosting) are deferred to the design phase.

## Glossary

- **Sweepstake_System**: The overall application that manages participants, assignments, results, standings, and prizes.
- **Participant**: A member of the team who takes part in the sweepstake and is eligible to be assigned nations.
- **Nation**: A national football team competing in the World Cup tournament being tracked.
- **Assignment**: A recorded link between exactly one Participant and exactly one Nation.
- **Assignment_Engine**: The component that randomly distributes Nations among Participants.
- **Match**: A single game between two Nations, with a final score for each Nation.
- **Match_Recorder**: The component that accepts and stores Match results.
- **Champion**: The Nation that wins the final Match of the World Cup tournament.
- **Points**: A numeric score accumulated by a Participant, derived from the results of Matches played by that Participant's assigned Nations.
- **League_Table**: The ranked list of Participants ordered by total Points.
- **Tournament_Winner_Prize**: The prize awarded to the Participant assigned the Champion.
- **League_Prize**: The prize awarded to the Participant ranked first in the League_Table.
- **Administrator**: A Participant or operator with permission to manage participants, run assignments, and record Match results.

## Requirements

### Requirement 1: Manage Participants

**User Story:** As an Administrator, I want to maintain the list of participants, so that the sweepstake reflects the people taking part.

#### Acceptance Criteria

1. WHEN an Administrator submits a participant name that, after trimming leading and trailing whitespace, contains between 1 and 100 characters and does not match any existing participant name when compared case-insensitively, THE Sweepstake_System SHALL add the participant to the participant list.
2. IF an Administrator submits a participant name that matches an existing participant name when compared case-insensitively and ignoring leading and trailing whitespace, THEN THE Sweepstake_System SHALL reject the submission, leave the participant list unchanged, and return a duplicate-name error indicating the name already exists.
3. IF an Administrator submits a participant name that is empty or contains only whitespace after trimming, THEN THE Sweepstake_System SHALL reject the submission, leave the participant list unchanged, and return a validation error indicating the name is required.
4. IF an Administrator submits a participant name that exceeds 100 characters after trimming leading and trailing whitespace, THEN THE Sweepstake_System SHALL reject the submission, leave the participant list unchanged, and return a validation error indicating the name exceeds the maximum length.
5. WHEN an Administrator removes an existing participant before any Assignments have been generated, THE Sweepstake_System SHALL delete the participant from the participant list.
6. IF an Administrator attempts to remove a participant after Assignments have been generated, THEN THE Sweepstake_System SHALL reject the request, retain the participant in the participant list, and return an assignments-exist error.
7. IF an Administrator attempts to remove a participant that does not exist in the participant list, THEN THE Sweepstake_System SHALL reject the request, leave the participant list unchanged, and return a participant-not-found error.
8. THE Sweepstake_System SHALL provide the current list of participants on request.

### Requirement 2: Manage Tournament Nations

**User Story:** As an Administrator, I want to maintain the list of competing nations, so that assignments and results are based on the correct tournament.

#### Acceptance Criteria

1. WHEN an Administrator submits a Nation name that contains between 1 and 100 characters after leading and trailing whitespace is removed AND does not match any existing Nation name in the Nation list when compared case-insensitively, THE Sweepstake_System SHALL add the Nation to the Nation list.
2. IF an Administrator submits a Nation name that matches an existing Nation name in the Nation list when compared case-insensitively and ignoring leading and trailing whitespace, THEN THE Sweepstake_System SHALL reject the submission, return a duplicate-nation error, and leave the Nation list unchanged.
3. IF an Administrator submits a Nation name that is empty, contains only whitespace, or exceeds 100 characters after leading and trailing whitespace is removed, THEN THE Sweepstake_System SHALL reject the submission and return a validation error.
4. WHEN an Administrator removes a Nation before Assignments have been generated, THE Sweepstake_System SHALL delete the Nation from the Nation list.
5. THE Sweepstake_System SHALL provide the current list of Nations on request.

### Requirement 3: Randomly Assign Nations to Participants

**User Story:** As an Administrator, I want nations assigned to participants at random, so that the sweepstake is fair and unbiased.

#### Acceptance Criteria

1. WHEN an Administrator triggers assignment, THE Assignment_Engine SHALL assign every Nation in the Nation list to exactly one Participant, leaving no Nation unassigned and assigning no Nation to more than one Participant.
2. WHEN an Administrator triggers assignment AND the number of Nations is greater than or equal to the number of Participants, THE Assignment_Engine SHALL assign at least one Nation to every Participant.
3. WHEN an Administrator triggers assignment AND the number of Nations exceeds the number of Participants, THE Assignment_Engine SHALL distribute the surplus Nations so that the difference between the largest and smallest count of Nations per Participant is at most 1.
4. WHEN the Assignment_Engine assigns Nations, THE Assignment_Engine SHALL produce a distribution in which every valid distribution permitted by criteria 1 through 3 has equal probability of being selected, with no fixed dependence on the insertion order of Participants or Nations.
5. IF an Administrator triggers assignment when the Participant list is empty, THEN THE Assignment_Engine SHALL reject the request, leave any existing Assignments unchanged, and return a no-participants error.
6. IF an Administrator triggers assignment when the Nation list is empty, THEN THE Assignment_Engine SHALL reject the request, leave any existing Assignments unchanged, and return a no-nations error.
7. IF an Administrator triggers assignment when Assignments already exist and replacement has not been confirmed, THEN THE Assignment_Engine SHALL reject the request, leave the existing Assignments unchanged, and return a confirmation-required status.
8. WHEN an Administrator triggers assignment with replacement confirmed AND Assignments already exist, THE Assignment_Engine SHALL discard the existing Assignments and generate a new set of Assignments.
9. THE Sweepstake_System SHALL provide the current Assignments, including each Participant and the Nations assigned to that Participant, on request.

### Requirement 4: Record Match Results

**User Story:** As an Administrator, I want to record the score of each match, so that points and standings can be calculated.

#### Acceptance Criteria

1. WHEN an Administrator submits a Match result containing two distinct Nations that both exist in the Nation list and an integer goal count from 0 to 99 inclusive for each Nation, THE Match_Recorder SHALL store the Match result and return a confirmation that identifies the stored Match by its two Nations.
2. IF an Administrator submits a Match result referencing a Nation that is not in the Nation list, THEN THE Match_Recorder SHALL reject the submission and return an unknown-nation error indicating which Nation was not recognized.
3. IF an Administrator submits a Match result in which both Nations are the same, THEN THE Match_Recorder SHALL reject the submission and return a validation error indicating that the two Nations must be distinct.
4. IF an Administrator submits a Match result containing a goal count that is non-integer, less than 0, or greater than 99, THEN THE Match_Recorder SHALL reject the submission and return a validation error indicating the goal count is out of the accepted range.
5. WHEN an Administrator updates a previously stored Match result, identified by its two Nations, THE Match_Recorder SHALL replace the stored result with the updated values and return a confirmation identifying the updated Match.
6. IF an Administrator attempts to update a Match result that has not been previously stored, THEN THE Match_Recorder SHALL reject the update and return a not-found error indicating no matching stored result exists.
7. IF the Match_Recorder rejects a submission or update, THEN THE Match_Recorder SHALL leave all previously stored Match results unchanged.
8. THE Sweepstake_System SHALL provide the list of recorded Match results, including the two Nations and the goal count for each Nation per Match, on request.

### Requirement 5: Calculate Points

**User Story:** As a Participant, I want points calculated consistently from match results, so that I can trust the standings.

#### Acceptance Criteria

1. WHEN a Match result is stored AND the two Nations have different goal counts, THE Sweepstake_System SHALL award exactly 3 Points to the Nation with the higher goal count for that Match and 0 win/draw Points to the other Nation.
2. WHEN a Match result is stored AND both Nations have an equal goal count, THE Sweepstake_System SHALL award exactly 1 Point to each Nation for that Match.
3. WHEN a Match result is stored, THE Sweepstake_System SHALL award to each Nation a number of additional Points equal to that Nation's goal count in the Match, where the goal count is a non-negative integer.
4. THE Sweepstake_System SHALL calculate a Nation's total Points as the sum, across every stored Match in which that Nation participated, of the win/draw Points from criteria 1 and 2 plus the goal Points from criterion 3.
5. THE Sweepstake_System SHALL calculate a Participant's total Points as the arithmetic sum of the total Points of all Nations assigned to that Participant, and SHALL report 0 total Points for a Participant whose assigned Nations have no stored Match results.
6. WHEN a Match result is added, updated, or removed, THE Sweepstake_System SHALL recalculate the total Points of every Participant from the complete current set of stored Match results.

### Requirement 6: Display the League Table

**User Story:** As a Participant, I want to see a ranked league table, so that I know who is leading the points competition.

#### Acceptance Criteria

1. THE League_Table SHALL list every Participant in the participant list together with that Participant's total Points and that Participant's rank position.
2. THE League_Table SHALL order Participants by total Points from highest to lowest.
3. WHEN two or more Participants have equal total Points, THE League_Table SHALL order those tied Participants among themselves in ascending alphabetical order of Participant name, compared case-insensitively.
4. IF two or more Participants have equal total Points, THEN THE League_Table SHALL assign those tied Participants the same rank position.
5. THE League_Table SHALL assign each Participant a rank position equal to the count of Participants with strictly greater total Points plus 1.
6. IF the participant list is empty, THEN THE League_Table SHALL return an empty League_Table containing no Participants and no rank positions.
7. THE League_Table SHALL provide the current rankings, reflecting all stored Match results at the time of the request, on request.

### Requirement 7: Determine the Tournament Winner Prize

**User Story:** As a Participant, I want the system to identify who holds the champion nation, so that the tournament winner prize can be awarded.

#### Acceptance Criteria

1. WHEN an Administrator records a Champion that exists in the Nation list and is currently assigned to a Participant, THE Sweepstake_System SHALL identify that single Participant as the Tournament_Winner_Prize recipient.
2. IF an Administrator records a Champion that is not in the Nation list, THEN THE Sweepstake_System SHALL reject the submission and return an unknown-nation error.
3. IF an Administrator records a Champion that exists in the Nation list but has no existing Assignment, THEN THE Sweepstake_System SHALL reject the submission and return a champion-not-assigned error.
4. WHEN an Administrator records a Champion AND a Champion has already been recorded, THE Sweepstake_System SHALL replace the previously recorded Champion and update the Tournament_Winner_Prize recipient accordingly.
5. THE Sweepstake_System SHALL provide the Tournament_Winner_Prize recipient on request after the Champion has been recorded.
6. IF the Tournament_Winner_Prize recipient is requested before the Champion has been recorded, THEN THE Sweepstake_System SHALL return a champion-not-recorded status.

### Requirement 8: Determine the League Prize

**User Story:** As a Participant, I want the system to identify the points leader, so that the league prize can be awarded.

#### Acceptance Criteria

1. WHEN an Administrator finalizes the League_Table after all scheduled Matches have been recorded, THE Sweepstake_System SHALL identify the Participant or Participants at rank position 1 as the League_Prize recipients.
2. WHERE exactly one Participant holds rank position 1 in the League_Table, THE Sweepstake_System SHALL report that single Participant as the sole League_Prize recipient.
3. WHERE two or more Participants share rank position 1 in the League_Table, THE Sweepstake_System SHALL report all tied Participants as joint League_Prize recipients.
4. THE Sweepstake_System SHALL provide the League_Prize recipient or recipients on request after the League_Table has been finalized.
5. IF the League_Prize recipient is requested before the League_Table has been finalized, THEN THE Sweepstake_System SHALL return a league-not-finalized status.
